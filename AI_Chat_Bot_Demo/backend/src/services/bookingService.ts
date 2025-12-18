// services/bookingService.ts

import { DateTime } from "luxon";
import { getBotConfigBySlug, BookingConfig } from "../bots/config";
import { createCalendarEvent, checkConflicts } from "../google/calendar";
import { prisma } from "../prisma/prisma";
import { sendBotMail } from "./mailer";

export interface BookAppointmentArgs {
  name: string;
  email: string;
  phone: string;
  service: string;
  datetime: string; // ISO-like string from the tool
  // Allow future custom fields without breaking
  [key: string]: any;
}

export interface BookingResult {
  success: boolean;
  start?: string;
  end?: string;
  addToCalendarUrl?: string;
  errorMessage?: string;

  confirmationEmailSent?: boolean;
  confirmationEmailError?: string;
}

let bookingRequestCounter = 0;
function nextBookingRequestId(): string {
  bookingRequestCounter += 1;
  return bookingRequestCounter.toString().padStart(4, "0");
}

const DEFAULT_REQUIRED_FIELDS = [
  "name",
  "email",
  "phone",
  "service",
  "datetime"
];

type NormalizedBookingConfig = {
  enabled: true;
  provider: "google_calendar";
  calendarId: string;
  timeZone: string;
  defaultDurationMinutes: number;

  minLeadHours: number | null;
  maxAdvanceDays: number | null;

  confirmationEmailEnabled: boolean;

  confirmationSubjectTemplate: string | null;
  confirmationBodyTextTemplate: string | null;
  confirmationBodyHtmlTemplate: string | null;

  requiredFields: string[];
  customFields: string[];
};

function normalizeBookingConfig(
  raw: BookingConfig | undefined
): NormalizedBookingConfig | null {
  if (!raw || !raw.enabled) return null;
  if (raw.provider !== "google_calendar") return null;
  if (!raw.calendarId || !raw.timeZone || !raw.defaultDurationMinutes) {
    return null;
  }

  const minLeadHours =
    typeof raw.minLeadHours === "number" && raw.minLeadHours >= 0
      ? raw.minLeadHours
      : null;

  const maxAdvanceDays =
    typeof raw.maxAdvanceDays === "number" && raw.maxAdvanceDays > 0
      ? raw.maxAdvanceDays
      : null;

  const confirmationEmailEnabled =
    raw.bookingConfirmationEmailEnabled === false ? false : true;

  let requiredFields =
    Array.isArray(raw.requiredFields) && raw.requiredFields.length > 0
      ? raw.requiredFields
      : DEFAULT_REQUIRED_FIELDS;

  // Clean + dedupe + ensure base fields exist
  const set = new Set<string>();
  for (const f of requiredFields) {
    const trimmed = f.trim();
    if (trimmed) set.add(trimmed);
  }
  for (const base of DEFAULT_REQUIRED_FIELDS) set.add(base);
  requiredFields = Array.from(set);

  const customFields = requiredFields.filter(
    (f) => !DEFAULT_REQUIRED_FIELDS.includes(f)
  );

  return {
    enabled: true,
    provider: "google_calendar",
    calendarId: raw.calendarId,
    timeZone: raw.timeZone,
    defaultDurationMinutes: raw.defaultDurationMinutes,

    minLeadHours,
    maxAdvanceDays,

    confirmationEmailEnabled,

    confirmationSubjectTemplate:
      raw.bookingConfirmationSubjectTemplate ?? null,
    confirmationBodyTextTemplate:
      raw.bookingConfirmationBodyTextTemplate ?? null,
    confirmationBodyHtmlTemplate:
      raw.bookingConfirmationBodyHtmlTemplate ?? null,

    requiredFields,
    customFields
  };
}

export async function handleBookAppointment(
  slug: string,
  args: BookAppointmentArgs
): Promise<BookingResult> {
  const requestId = nextBookingRequestId();
  console.log("📅 [Booking] Incoming booking request", {
    requestId,
    slug,
    args
  });

  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    const result: BookingResult = {
      success: false,
      errorMessage: "Bot not found for this booking."
    };
    console.warn("📅 [Booking] Rejected - bot not found", {
      requestId,
      slug
    });
    return result;
  }

  const bookingCfg = normalizeBookingConfig(botConfig.booking);
  if (!bookingCfg) {
    const result: BookingResult = {
      success: false,
      errorMessage: "Booking is not enabled for this bot."
    };
    console.warn("📅 [Booking] Rejected - booking disabled or misconfigured", {
      requestId,
      slug
    });
    return result;
  }

  const {
    calendarId,
    timeZone,
    defaultDurationMinutes,
    minLeadHours,
    maxAdvanceDays,
    confirmationEmailEnabled
  } = bookingCfg;

  // Enforce required fields from config
  const missing: string[] = [];
  for (const field of bookingCfg.requiredFields) {
    const value = (args as any)[field];
    if (
      value == null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    const result: BookingResult = {
      success: false,
      errorMessage: `Missing required booking fields: ${missing.join(", ")}.`
    };
    console.warn("📅 [Booking] Rejected - missing fields by config", {
      requestId,
      slug,
      missing
    });
    return result;
  }

  // Basic arguments validation for core fields
  if (!args.name || !args.service || !args.datetime || !args.email) {
    const result: BookingResult = {
      success: false,
      errorMessage: "Missing required booking fields."
    };
    console.warn("📅 [Booking] Rejected - missing core fields", {
      requestId,
      slug,
      missing: {
        name: !args.name,
        email: !args.email,
        service: !args.service,
        datetime: !args.datetime
      }
    });
    return result;
  }

  const phone = args.phone || "";

  // Parse datetime as local in the business time zone
  const start = DateTime.fromISO(args.datetime, { zone: timeZone });
  if (!start.isValid) {
    const result: BookingResult = {
      success: false,
      errorMessage: "Invalid date/time format for booking."
    };
    console.warn("📅 [Booking] Rejected - invalid datetime", {
      requestId,
      slug,
      datetime: args.datetime,
      timeZone
    });
    return result;
  }

  const now = DateTime.now().setZone(timeZone);

  if (start < now) {
    const result: BookingResult = {
      success: false,
      errorMessage:
        "The requested time is in the past. Please choose another time."
    };
    console.warn("📅 [Booking] Rejected - time in the past", {
      requestId,
      slug,
      requested: start.toISO(),
      now: now.toISO()
    });
    return result;
  }

  // Enforce bookingMinLeadHours
  if (minLeadHours !== null && minLeadHours > 0) {
    const minAllowed = now.plus({ hours: minLeadHours });
    if (start < minAllowed) {
      const result: BookingResult = {
        success: false,
        errorMessage: `Bookings must be made at least ${minLeadHours} hour(s) in advance.`
      };
      console.warn("📅 [Booking] Rejected - below min lead hours", {
        requestId,
        slug,
        requested: start.toISO(),
        minAllowed: minAllowed.toISO(),
        minLeadHours
      });
      return result;
    }
  }

  // Enforce bookingMaxAdvanceDays
  if (maxAdvanceDays !== null && maxAdvanceDays > 0) {
    const maxAllowed = now.plus({ days: maxAdvanceDays });
    if (start > maxAllowed) {
      const result: BookingResult = {
        success: false,
        errorMessage: `Bookings cannot be made more than ${maxAdvanceDays} day(s) in advance.`
      };
      console.warn("📅 [Booking] Rejected - beyond max advance days", {
        requestId,
        slug,
        requested: start.toISO(),
        maxAllowed: maxAllowed.toISO(),
        maxAdvanceDays
      });
      return result;
    }
  }

  const end = start.plus({ minutes: defaultDurationMinutes });

  console.log("📅 [Booking] Validated booking slot", {
    requestId,
    slug,
    calendarId,
    timeZone,
    start: start.toISO(),
    end: end.toISO(),
    durationMinutes: defaultDurationMinutes
  });

  // Optional: conflict check
  try {
    const hasConflict = await checkConflicts({
      calendarId,
      timeMin: start.toISO()!,
      timeMax: end.toISO()!
    });

    if (hasConflict) {
      const result: BookingResult = {
        success: false,
        errorMessage:
          "That time appears to be already booked. Please choose another time."
      };
      console.warn("📅 [Booking] Conflict detected", {
        requestId,
        slug,
        calendarId,
        start: start.toISO(),
        end: end.toISO()
      });
      return result;
    }

    console.log("📅 [Booking] No conflicts found", {
      requestId,
      slug,
      calendarId
    });
  } catch (err) {
    console.error("📅 [Booking] Error checking conflicts in Google Calendar", {
      requestId,
      slug,
      error: err
    });
    // Continue anyway; still try to create event
  }

  try {
    const summary = `${args.service} - ${args.name}`;
    const descriptionLines: string[] = [
      `Service: ${args.service}`,
      `Name: ${args.name}`,
      `Email: ${args.email}`,
      `Phone: ${phone || "(not provided)"}`
    ];

    // Append any custom fields from the tool arguments
    const customFieldEntries = Object.entries(args).filter(
      ([key]) =>
        !DEFAULT_REQUIRED_FIELDS.includes(key)
    );
    for (const [key, value] of customFieldEntries) {
      if (typeof value === "string" && value.trim().length > 0) {
        descriptionLines.push(`${key}: ${value.trim()}`);
      }
    }

    const description = descriptionLines.join("\n");

    console.log("📅 [Booking] Creating calendar event", {
      requestId,
      slug,
      calendarId,
      summary,
      start: start.toISO(),
      end: end.toISO()
    });

    const event = await createCalendarEvent({
      calendarId,
      summary,
      description,
      start: start.toISO()!,
      end: end.toISO()!,
      timeZone
    });

    const addToCalendarUrl = buildGoogleCalendarUrl({
      title: `${args.service} - ${botConfig.name}`,
      description,
      start,
      end,
      location: botConfig.domain || ""
    });

    // Persist booking in our DB for reminders / admin UI
    if (botConfig.botId) {
      try {
        await prisma.booking.create({
          data: {
            botId: botConfig.botId,
            name: args.name,
            email: args.email,
            phone,
            service: args.service,
            start: start.toJSDate(),
            end: end.toJSDate(),
            timeZone,
            calendarId,
            calendarEventId: event.id ?? null,
            reminderEmailSentAt: null
          }
        });

        console.log("✅ [Booking] Booking row created", {
          requestId,
          slug,
          botId: botConfig.botId,
          email: args.email
        });
      } catch (dbError) {
        console.error("❌ [Booking] Failed to persist booking in DB", {
          requestId,
          slug,
          error: dbError
        });
        // Event still exists, so we don't fail for the user
      }
    } else {
      console.warn(
        "📅 [Booking] Static/demo bot has no botId; skipping DB booking row.",
        { slug, requestId }
      );
    }

    // Try sending confirmation email (subject to plan limits)
    let confirmationEmailSent = false;
    let confirmationEmailError: string | undefined;

    if (confirmationEmailEnabled) {
      const emailResult = await sendBookingConfirmationEmail({
        botId: botConfig.botId ?? null,
        botName: botConfig.name,
        botDomain: botConfig.domain || null,
        bookingCfg,
        args,
        start,
        end,
        addToCalendarUrl
      });

      confirmationEmailSent = emailResult.sent;
      if (!emailResult.sent && emailResult.reason) {
        confirmationEmailError = emailResult.reason;
      }
    }

    const result: BookingResult = {
      success: true,
      start: event.start,
      end: event.end,
      addToCalendarUrl,
      confirmationEmailSent,
      confirmationEmailError
    };

    console.log("✅ [Booking] Event created successfully", {
      requestId,
      slug,
      calendarId,
      eventId: event.id,
      start: event.start,
      end: event.end,
      addToCalendarUrl,
      confirmationEmailSent,
      confirmationEmailError
    });

    return result;
  } catch (err) {
    console.error("❌ [Booking] Error creating calendar event", {
      requestId,
      slug,
      calendarId,
      error: err
    });

    const result: BookingResult = {
      success: false,
      errorMessage: "Failed to create calendar event due to an internal error."
    };
    return result;
  }
}

function buildGoogleCalendarUrl(params: {
  title: string;
  description: string;
  start: DateTime;
  end: DateTime;
  location?: string | null;
}): string {
  const startUtc = params.start.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
  const endUtc = params.end.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");

  const base = "https://calendar.google.com/calendar/render?action=TEMPLATE";

  const url = new URL(base);
  url.searchParams.set("text", params.title);
  url.searchParams.set("dates", `${startUtc}/${endUtc}`);
  url.searchParams.set("details", params.description);
  if (params.location) {
    url.searchParams.set("location", params.location);
  }

  return url.toString();
}

type SendBookingConfirmationEmailResult = {
  sent: boolean;
  reason?: string;
};

async function sendBookingConfirmationEmail(params: {
  botId: string | null;
  botName: string;
  botDomain: string | null;
  bookingCfg: NormalizedBookingConfig;
  args: BookAppointmentArgs;
  start: DateTime;
  end: DateTime;
  addToCalendarUrl: string;
}): Promise<SendBookingConfirmationEmailResult> {
  const { botId, botName, botDomain, bookingCfg, args, start, addToCalendarUrl } =
    params;

  const brandName = botName || "our business";
  const brandUrl = botDomain || "";

  const formattedDate = start.toFormat("cccc, dd LLLL yyyy");
  const formattedTime = start.toFormat("HH:mm");

  const contextText: Record<string, string> = {
    name: args.name,
    email: args.email,
    phone: args.phone || "",
    service: args.service,
    date: formattedDate,
    time: formattedTime,
    timezone: bookingCfg.timeZone,
    brandName,
    brandUrl,
    calendarUrl: addToCalendarUrl
  };

  const contextHtml: Record<string, string> = {
    name: escapeHtml(args.name),
    email: escapeHtml(args.email),
    phone: escapeHtml(args.phone || ""),
    service: escapeHtml(args.service),
    date: escapeHtml(formattedDate),
    time: escapeHtml(formattedTime),
    timezone: escapeHtml(bookingCfg.timeZone),
    brandName: escapeHtml(brandName),
    brandUrl: escapeHtml(brandUrl),
    calendarUrl: escapeHtml(addToCalendarUrl)
  };

  const subjectTemplate =
    bookingCfg.confirmationSubjectTemplate ||
    "Your {{service}} booking on {{date}} at {{time}} with {{brandName}}";

  const defaultText =
    `Hi {{name}},\n\n` +
    `Your booking with {{brandName}} is confirmed.\n\n` +
    `Service: {{service}}\n` +
    `Date: {{date}}\n` +
    `Time: {{time}} ({{timezone}})\n\n` +
    `You can add this booking to your Google Calendar using this link:\n` +
    `{{calendarUrl}}\n\n` +
    `If you need to reschedule, please contact us.\n\n` +
    `Thank you!`;

  const textTemplate =
    bookingCfg.confirmationBodyTextTemplate || defaultText;

  const defaultHtml =
    `<p>Hi {{name}},</p>` +
    `<p>Your booking with <strong>{{brandName}}</strong> is confirmed.</p>` +
    `<p>` +
    `<strong>Service:</strong> {{service}}<br>` +
    `<strong>Date:</strong> {{date}}<br>` +
    `<strong>Time:</strong> {{time}} ({{timezone}})` +
    `</p>` +
    `<p>` +
    `<a href="{{calendarUrl}}" ` +
    `style="display:inline-block;padding:10px 16px;border-radius:4px;font-weight:bold;text-decoration:none;background-color:#4285F4;color:#ffffff;">` +
    `Add to Google Calendar` +
    `</a>` +
    `</p>` +
    `<p>If you need to reschedule, please contact us.</p>` +
    `<p>Thank you!</p>`;

  const htmlTemplate =
    bookingCfg.confirmationBodyHtmlTemplate || defaultHtml;

  const subject = renderTemplate(subjectTemplate, contextText);
  const text = renderTemplate(textTemplate, contextText);
  const html = renderTemplate(htmlTemplate, contextHtml);

  const sendResult = await sendBotMail({
    botId,
    kind: "booking_confirmation",
    to: args.email,
    subject,
    text,
    html
  });

  if (!sendResult.sent) {
    return { sent: false, reason: sendResult.reason || "send_failed" };
  }

  return { sent: true };
}

function renderTemplate(
  template: string,
  context: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = context[key] ?? "";
    return value;
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
