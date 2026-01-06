// services/bookingService.ts

import { DateTime } from "luxon";
import { getBotConfigBySlug, BookingConfig } from "../bots/config";
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  countEventsInRange
} from "../google/calendar";
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

export interface UpdateAppointmentArgs {
  email: string;
  originalDatetime: string; // ISO-like string for the existing booking time
  newDatetime: string; // ISO-like string for the new time
  service?: string;
  [key: string]: any;
}

export interface CancelAppointmentArgs {
  email: string;
  originalDatetime: string; // ISO-like string for the existing booking time
  reason?: string;
  [key: string]: any;
}

export interface BookingResult {
  success: boolean;
  action?: "created" | "updated" | "cancelled";
  start?: string;
  end?: string;
  addToCalendarUrl?: string;
  errorMessage?: string;

  confirmationEmailSent?: boolean;
  confirmationEmailError?: string;

  /**
   * Optional alternative slots (ISO strings) near the requested time.
   * These are pre-filtered by DB + weekly schedule and, when a calendar is
   * configured, also checked against Google Calendar conflicts.
   */
  suggestedSlots?: string[];
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
  maxSimultaneousBookings: number;

  confirmationEmailEnabled: boolean;

  confirmationSubjectTemplate: string | null;
  confirmationBodyTextTemplate: string | null;
  confirmationBodyHtmlTemplate: string | null;

  cancellationSubjectTemplate: string | null;      // NEW
  cancellationBodyTextTemplate: string | null;     // NEW
  cancellationBodyHtmlTemplate: string | null;

  requiredFields: string[];
  customFields: string[];
};

type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

type BookingTimeWindow = {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
};

type BookingWeeklySchedule = Partial<Record<WeekdayKey, BookingTimeWindow[]>>;

const WEEKDAY_KEYS: WeekdayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
];

function parseTimeToMinutes(hhmm: string): number | null {
  const parts = hhmm.split(":");
  if (parts.length !== 2) return null;

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function getWeekdayKey(dt: DateTime): WeekdayKey {
  // Luxon: Monday = 1, Sunday = 7
  return WEEKDAY_KEYS[dt.weekday - 1];
}

function isWithinWeeklySchedule(
  dt: DateTime,
  durationMinutes: number,
  schedule: BookingWeeklySchedule | null
): boolean {
  // No schedule configured → allow any time
  if (!schedule) return true;

  const dayKey = getWeekdayKey(dt);
  const windows = schedule[dayKey];
  if (!windows || windows.length === 0) return false;

  const startMinutes = dt.hour * 60 + dt.minute;
  const endMinutes = startMinutes + durationMinutes;

  // A booking is valid if fully contained in at least one window for that day
  return windows.some((w) => {
    const from = parseTimeToMinutes(w.start);
    const to = parseTimeToMinutes(w.end);
    if (from == null || to == null || from >= to) return false;
    return startMinutes >= from && endMinutes <= to;
  });
}

async function loadBotWeeklySchedule(
  botId: string | null
): Promise<BookingWeeklySchedule | null> {
  if (!botId) return null;

  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { bookingWeeklySchedule: true }
  });

  if (!bot || !bot.bookingWeeklySchedule) {
    return null;
  }

  return bot.bookingWeeklySchedule as BookingWeeklySchedule;
}


async function computeSuggestedSlots(options: {
  requestedStart: DateTime;
  bookingCfg: NormalizedBookingConfig;
  botId: string | null;
  weeklySchedule: BookingWeeklySchedule | null;
  calendarId: string;
  shouldCheckCalendarConflicts: boolean;
}): Promise<string[]> {
  const {
    requestedStart,
    bookingCfg,
    botId,
    weeklySchedule,
    calendarId,
    shouldCheckCalendarConflicts
  } = options;

  const {
    timeZone,
    defaultDurationMinutes,
    minLeadHours,
    maxAdvanceDays,
    maxSimultaneousBookings
  } = bookingCfg;

  const now = DateTime.now().setZone(timeZone);

  const duration = defaultDurationMinutes || 30;
  if (duration <= 0) return [];

  // Search window around the requested time (±4 hours)
  const SEARCH_HOURS = 4;
  const windowStart = requestedStart.minus({ hours: SEARCH_HOURS });
  const windowEnd = requestedStart.plus({ hours: SEARCH_HOURS });

  // Preload overlapping bookings in this window for capacity checks
  let existing: { start: Date; end: Date }[] = [];
  if (botId && maxSimultaneousBookings > 0) {
    existing = await prisma.booking.findMany({
      where: {
        botId,
        status: "ACTIVE",
        start: { lt: windowEnd.toJSDate() },
        end: { gt: windowStart.toJSDate() }
      },
      select: { start: true, end: true }
    });
  }

  const candidates: DateTime[] = [];
  let cursor = windowStart;

  const maxIterations =
    Math.ceil(((SEARCH_HOURS * 2 * 60) / duration)) + 2;

  for (let i = 0; i < maxIterations && cursor <= windowEnd; i++) {
    const candidateStart = cursor;
    cursor = cursor.plus({ minutes: duration });

    // Skip the original requested time (we already know it's not usable)
    if (candidateStart.toMillis() === requestedStart.toMillis()) continue;

    const candidateEnd = candidateStart.plus({ minutes: duration });

    // Basic constraints: future only
    if (candidateStart < now) continue;

    if (minLeadHours !== null && minLeadHours > 0) {
      const minAllowed = now.plus({ hours: minLeadHours });
      if (candidateStart < minAllowed) continue;
    }

    if (maxAdvanceDays !== null && maxAdvanceDays > 0) {
      const maxAllowed = now.plus({ days: maxAdvanceDays });
      if (candidateStart > maxAllowed) continue;
    }

    if (
      !isWithinWeeklySchedule(
        candidateStart,
        duration,
        weeklySchedule
      )
    ) {
      continue;
    }

    if (botId && maxSimultaneousBookings > 0) {
      const overlappingCount = existing.filter((b) => {
        const bStart = DateTime.fromJSDate(b.start);
        const bEnd = DateTime.fromJSDate(b.end);
        return bStart < candidateEnd && bEnd > candidateStart;
      }).length;

      if (overlappingCount >= maxSimultaneousBookings) {
        continue;
      }
    }

    candidates.push(candidateStart);
  }

  if (candidates.length === 0) {
    return [];
  }

  const before = candidates
    .filter((dt) => dt < requestedStart)
    .sort((a, b) => a.toMillis() - b.toMillis());

  const after = candidates
    .filter((dt) => dt >= requestedStart)
    .sort((a, b) => a.toMillis() - b.toMillis());

  let calendarChecks = 0;
  const MAX_CALENDAR_CHECKS = 8;

  async function isFreeInCalendar(slotStart: DateTime): Promise<boolean> {
    if (!shouldCheckCalendarConflicts || !calendarId) {
      // This bot does not use external conflicts (e.g. no calendar configured)
      return true;
    }

    if (calendarChecks >= MAX_CALENDAR_CHECKS) {
      // Hard cap on external API calls
      return false;
    }

    calendarChecks += 1;
    const slotEnd = slotStart.plus({ minutes: duration });

    try {
      const gcalEventsCount = await countEventsInRange({
        calendarId,
        timeMin: slotStart.toISO()!,
        timeMax: slotEnd.toISO()!,
        maxResults: maxSimultaneousBookings
      });

      // Slot is free in the calendar if it has fewer events than our capacity
      return gcalEventsCount < maxSimultaneousBookings;
    } catch (err) {
      // On error, be conservative: treat as conflict so we don't suggest it.
      console.error("📅 [Booking] Error checking calendar capacity for suggestion", {
        calendarId,
        start: slotStart.toISO(),
        error: err
      });
      return false;
    }
  }

  async function pickFirstFree(sortedCandidates: DateTime[]): Promise<DateTime | null> {
    for (const dt of sortedCandidates) {
      const free = await isFreeInCalendar(dt);
      if (free) return dt;
    }
    return null;
  }

  const suggestions: DateTime[] = [];

  const bestBefore = await pickFirstFree([...before].reverse()); // closest before
  const bestAfter = await pickFirstFree(after);                  // closest after

  if (bestBefore) suggestions.push(bestBefore);
  if (bestAfter) suggestions.push(bestAfter);

  // If we only have "after", try to get a second "after"
  if (!bestBefore && suggestions.length < 2 && bestAfter) {
    const remainingAfter = after.filter(
      (dt) => dt.toMillis() !== bestAfter.toMillis()
    );
    const secondAfter = await pickFirstFree(remainingAfter);
    if (secondAfter) suggestions.push(secondAfter);
  }

  // If we only have "before", try to get a second "before"
  if (!bestAfter && suggestions.length < 2 && bestBefore) {
    const remainingBefore = [...before]
      .reverse()
      .filter((dt) => dt.toMillis() !== bestBefore.toMillis());
    const secondBefore = await pickFirstFree(remainingBefore);
    if (secondBefore) suggestions.push(secondBefore);
  }

  return suggestions.slice(0, 2).map((dt) => dt.toISO()!);
}

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

  const maxSimultaneousBookings =
    typeof raw.maxSimultaneousBookings === "number" &&
    raw.maxSimultaneousBookings > 0
      ? raw.maxSimultaneousBookings
      : 1; // default to old behaviour: 1 booking per slot

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
    maxSimultaneousBookings,

    confirmationEmailEnabled,

    confirmationSubjectTemplate:
      raw.bookingConfirmationSubjectTemplate ?? null,
    confirmationBodyTextTemplate:
      raw.bookingConfirmationBodyTextTemplate ?? null,
    confirmationBodyHtmlTemplate:
      raw.bookingConfirmationBodyHtmlTemplate ?? null,

    cancellationSubjectTemplate:                      // NEW
      raw.bookingCancellationSubjectTemplate ?? null,
    cancellationBodyTextTemplate:                     // NEW
      raw.bookingCancellationBodyTextTemplate ?? null,
    cancellationBodyHtmlTemplate:                     // NEW
      raw.bookingCancellationBodyHtmlTemplate ?? null,

    requiredFields,
    customFields
  };
}

/**
 * Create a new booking.
 */
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
    confirmationEmailEnabled,
    maxSimultaneousBookings
  } = bookingCfg;

  const shouldCheckCalendarConflicts = !!calendarId;

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
      slug
    });
    return result;
  }

  const weeklySchedule = await loadBotWeeklySchedule(botConfig.botId ?? null);

  const start = DateTime.fromISO(args.datetime, { zone: timeZone });
  if (!start.isValid) {
    const result: BookingResult = {
      success: false,
      errorMessage:
        "The date/time you provided is not a valid format. Please try again."
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
  const suggestedSlots = await computeSuggestedSlots({
    requestedStart: start,
    bookingCfg,
    botId: botConfig.botId ?? null,
    weeklySchedule,
    calendarId,
    shouldCheckCalendarConflicts
  });

  const result: BookingResult = {
    success: false,
    errorMessage:
      "The requested time is in the past. Please choose another time.",
    suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
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
    const suggestedSlots = await computeSuggestedSlots({
      requestedStart: start,
      bookingCfg,
      botId: botConfig.botId ?? null,
      weeklySchedule,
      calendarId,
      shouldCheckCalendarConflicts
    });

    const result: BookingResult = {
      success: false,
      errorMessage: `Bookings must be made at least ${minLeadHours} hour(s) in advance.`,
      suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
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
    const suggestedSlots = await computeSuggestedSlots({
      requestedStart: start,
      bookingCfg,
      botId: botConfig.botId ?? null,
      weeklySchedule,
      calendarId,
      shouldCheckCalendarConflicts
    });

    const result: BookingResult = {
      success: false,
      errorMessage: `Bookings cannot be made more than ${maxAdvanceDays} day(s) in advance.`,
      suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
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

  // Enforce weekly opening hours (if configured on the bot)
  if (!isWithinWeeklySchedule(start, defaultDurationMinutes, weeklySchedule)) {
  const suggestedSlots = await computeSuggestedSlots({
    requestedStart: start,
    bookingCfg,
    botId: botConfig.botId ?? null,
    weeklySchedule,
    calendarId,
    shouldCheckCalendarConflicts
  });

  const result: BookingResult = {
    success: false,
    errorMessage:
      "That time is outside of the business's opening hours. Please choose another time within the available schedule.",
    suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
  };

  console.warn("📅 [Booking] Rejected - outside opening hours", {
    requestId,
    slug,
    start: start.toISO(),
    durationMinutes: defaultDurationMinutes,
    timeZone,
    weeklyScheduleConfigured: !!weeklySchedule
  });

  return result;
}

  const end = start.plus({ minutes: defaultDurationMinutes });

  if (botConfig.botId && maxSimultaneousBookings > 0) {
    const overlappingCount = await prisma.booking.count({
      where: {
        botId: botConfig.botId,
        status: "ACTIVE",
        // overlap condition: existing.start < newEnd && existing.end > newStart
        start: { lt: end.toJSDate() },
        end: { gt: start.toJSDate() }
      }
    });

    if (overlappingCount >= maxSimultaneousBookings) {
  const suggestedSlots = await computeSuggestedSlots({
    requestedStart: start,
    bookingCfg,
    botId: botConfig.botId ?? null,
    weeklySchedule,
    calendarId,
    shouldCheckCalendarConflicts
  });

  const result: BookingResult = {
    success: false,
    errorMessage:
      "That time slot is fully booked. Please choose another time.",
    suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
  };
  console.warn("📅 [Booking] Rejected - slot at capacity", {
    slug,
    botId: botConfig.botId,
    start: start.toISO(),
    end: end.toISO(),
    maxSimultaneousBookings,
    overlappingCount
  });
  return result;
}
  }

  console.log("📅 [Booking] Validated booking slot", {
    requestId,
    slug,
    calendarId,
    timeZone,
    start: start.toISO(),
    end: end.toISO(),
    durationMinutes: defaultDurationMinutes
  });

  // Optional: external calendar capacity check (Google Calendar)
  if (shouldCheckCalendarConflicts && maxSimultaneousBookings > 0) {
    try {
      const gcalEventsCount = await countEventsInRange({
        calendarId,
        timeMin: start.toISO()!,
        timeMax: end.toISO()!,
        // We don't need more than maxSimultaneousBookings events to know it's full
        maxResults: maxSimultaneousBookings
      });

      // If GCal already has >= maxSimultaneousBookings events in this slot,
      // we consider the slot fully booked.
      if (gcalEventsCount >= maxSimultaneousBookings) {
        const suggestedSlots = await computeSuggestedSlots({
          requestedStart: start,
          bookingCfg,
          botId: botConfig.botId ?? null,
          weeklySchedule,
          calendarId,
          shouldCheckCalendarConflicts
        });

        const result: BookingResult = {
          success: false,
          errorMessage:
            "That time slot is fully booked. Please choose another time.",
          suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
        };

        console.warn("📅 [Booking] Rejected - calendar at capacity", {
          requestId,
          slug,
          calendarId,
          start: start.toISO(),
          end: end.toISO(),
          maxSimultaneousBookings,
          gcalEventsCount
        });

        return result;
      }

      console.log("📅 [Booking] Calendar has free capacity for slot", {
        requestId,
        slug,
        calendarId,
        start: start.toISO(),
        end: end.toISO(),
        maxSimultaneousBookings,
        gcalEventsCount
      });
    } catch (err) {
      console.error("📅 [Booking] Error checking capacity in Google Calendar", {
        requestId,
        slug,
        calendarId,
        error: err
      });
      // Continue anyway; still try to create event
    }
  }

  try {
    const phone = args.phone?.trim() || "";

    const summary = `${args.service} - ${args.name}`;

    const descriptionLines: string[] = [
      `Service: ${args.service}`,
      `Name: ${args.name}`,
      `Email: ${args.email}`,
      `Phone: ${phone || "(not provided)"}`
    ];

    // Append any custom fields from the tool arguments
    const customFieldEntries = Object.entries(args).filter(
      ([key]) => !DEFAULT_REQUIRED_FIELDS.includes(key)
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
            status: "ACTIVE", // NEW: soft-delete status
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
      action: "created",
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

/**
 * Update (reschedule) an existing booking, identified by email + original datetime.
 */
export async function handleUpdateAppointment(
  slug: string,
  args: UpdateAppointmentArgs
): Promise<BookingResult> {
  const requestId = nextBookingRequestId();
  console.log("📅 [Booking] Incoming update request", {
    requestId,
    slug,
    args
  });

  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    return {
      success: false,
      action: "updated",
      errorMessage: "Bot not found for this booking."
    };
  }

  const bookingCfg = normalizeBookingConfig(botConfig.booking);
  if (!bookingCfg) {
    return {
      success: false,
      action: "updated",
      errorMessage: "Booking is not enabled for this bot."
    };
  }

  const {
  calendarId,
  timeZone,
  defaultDurationMinutes,
  minLeadHours,
  maxAdvanceDays,
  confirmationEmailEnabled,
  maxSimultaneousBookings
} = bookingCfg;

const shouldCheckCalendarConflicts = !!calendarId;

  if (!args.email || !args.originalDatetime || !args.newDatetime) {
    return {
      success: false,
      action: "updated",
      errorMessage:
        "To update a booking I need your email and both the original and new date/time."
    };
  }

  const original = DateTime.fromISO(args.originalDatetime, { zone: timeZone });
  if (!original.isValid) {
    return {
      success: false,
      action: "updated",
      errorMessage:
        "The original date/time you provided is not a valid format. Please try again."
    };
  }

  const existing = await findBookingByEmailAndApproxTime({
    botId: botConfig.botId ?? null,
    email: args.email,
    approxStart: original
  });

  if (!existing) {
    console.warn("📅 [Booking] Update rejected - existing booking not found", {
      requestId,
      slug,
      email: args.email,
      original: args.originalDatetime
    });
    return {
      success: false,
      action: "updated",
      errorMessage:
        "I couldn't find an existing booking with that email and date/time. Please check your details."
    };
  }

   const weeklySchedule = await loadBotWeeklySchedule(botConfig.botId ?? null);

  const newStart = DateTime.fromISO(args.newDatetime, { zone: timeZone });
  if (!newStart.isValid) {
    return {
      success: false,
      action: "updated",
      errorMessage: "The new date/time you provided is not a valid format."
    };
  }

  const now = DateTime.now().setZone(timeZone);

  if (newStart < now) {
  const suggestedSlots = await computeSuggestedSlots({
    requestedStart: newStart,
    bookingCfg,
    botId: botConfig.botId ?? null,
    weeklySchedule,
    calendarId,
    shouldCheckCalendarConflicts
  });

  return {
    success: false,
    action: "updated",
    errorMessage:
      "The new time is already in the past. Please choose another time.",
    suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
  };
}

  if (minLeadHours !== null && minLeadHours > 0) {
  const minAllowed = now.plus({ hours: minLeadHours });
  if (newStart < minAllowed) {
    const suggestedSlots = await computeSuggestedSlots({
      requestedStart: newStart,
      bookingCfg,
      botId: botConfig.botId ?? null,
      weeklySchedule,
      calendarId,
      shouldCheckCalendarConflicts
    });

    return {
      success: false,
      action: "updated",
      errorMessage: `Bookings must be updated to at least ${minLeadHours} hour(s) in advance.`,
      suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
    };
  }
}

  if (maxAdvanceDays !== null && maxAdvanceDays > 0) {
  const maxAllowed = now.plus({ days: maxAdvanceDays });
  if (newStart > maxAllowed) {
    const suggestedSlots = await computeSuggestedSlots({
      requestedStart: newStart,
      bookingCfg,
      botId: botConfig.botId ?? null,
      weeklySchedule,
      calendarId,
      shouldCheckCalendarConflicts
    });

    return {
      success: false,
      action: "updated",
      errorMessage: `Bookings cannot be moved more than ${maxAdvanceDays} day(s) in advance.`,
      suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
    };
  }
}

  if (!isWithinWeeklySchedule(newStart, defaultDurationMinutes, weeklySchedule)) {
  const suggestedSlots = await computeSuggestedSlots({
    requestedStart: newStart,
    bookingCfg,
    botId: botConfig.botId ?? null,
    weeklySchedule,
    calendarId,
    shouldCheckCalendarConflicts
  });

  return {
    success: false,
    action: "updated",
    errorMessage:
      "The new time is outside of the business's opening hours. Please choose another time within the available schedule.",
    suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
  };
}

  const newEnd = newStart.plus({ minutes: defaultDurationMinutes });

  if (botConfig.botId && maxSimultaneousBookings > 0) {
    const overlappingCount = await prisma.booking.count({
      where: {
        botId: botConfig.botId,
        status: "ACTIVE",
        // overlap condition: existing.start < newEnd && existing.end > newStart
        start: { lt: newEnd.toJSDate() },
        end: { gt: newStart.toJSDate() }
      }
    });

    if (overlappingCount >= maxSimultaneousBookings) {
      const suggestedSlots = await computeSuggestedSlots({
        requestedStart: newStart,
        bookingCfg,
        botId: botConfig.botId ?? null,
        weeklySchedule,
        calendarId,
        shouldCheckCalendarConflicts
      });

      return {
        success: false,
        action: "updated",
        errorMessage:
          "That time slot is fully booked. Please choose another time.",
        suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
      };
    }
  }

  // Check external calendar capacity for the new slot (Google Calendar)
  if (shouldCheckCalendarConflicts && maxSimultaneousBookings > 0) {
    try {
      const gcalEventsCount = await countEventsInRange({
        calendarId,
        timeMin: newStart.toISO()!,
        timeMax: newEnd.toISO()!,
        maxResults: maxSimultaneousBookings
      });

      if (gcalEventsCount >= maxSimultaneousBookings) {
        console.warn("📅 [Booking] Update rejected - calendar at capacity", {
          requestId,
          slug,
          calendarId,
          newStart: newStart.toISO(),
          newEnd: newEnd.toISO(),
          maxSimultaneousBookings,
          gcalEventsCount
        });

        const suggestedSlots = await computeSuggestedSlots({
          requestedStart: newStart,
          bookingCfg,
          botId: botConfig.botId ?? null,
          weeklySchedule,
          calendarId,
          shouldCheckCalendarConflicts
        });

        return {
          success: false,
          action: "updated",
          errorMessage:
            "That time slot is fully booked. Please choose another time.",
          suggestedSlots: suggestedSlots.length ? suggestedSlots : undefined
        };
      }
    } catch (err) {
      console.error("📅 [Booking] Error checking calendar capacity for update", {
        requestId,
        slug,
        calendarId,
        error: err
      });
      // On error we proceed; behaviour stays similar to before (best-effort check)
    }
  }

  // Update calendar event (if we know it)
  try {
    if (existing.calendarEventId && existing.calendarId) {
      await updateCalendarEvent({
        calendarId: existing.calendarId,
        eventId: existing.calendarEventId,
        summary: `${args.service ?? existing.service} - ${existing.name}`,
        description: buildUpdateEventDescription(existing),
        start: newStart.toISO()!,
        end: newEnd.toISO()!,
        timeZone
      });
    }
  } catch (err) {
    console.error("❌ [Booking] Failed to update calendar event", {
      requestId,
      slug,
      error: err
    });
    return {
      success: false,
      action: "updated",
      errorMessage:
        "We couldn't update the appointment in the calendar due to an internal error."
    };
  }

  const addToCalendarUrl = buildGoogleCalendarUrl({
    title: `${args.service ?? existing.service} - ${botConfig.name}`,
    description: buildUpdateEventDescription(existing),
    start: newStart,
    end: newEnd,
    location: botConfig.domain || ""
  });

  // Update DB row
  try {
    await prisma.booking.update({
      where: { id: existing.id },
      data: {
        start: newStart.toJSDate(),
        end: newEnd.toJSDate(),
        service: args.service ?? existing.service
      }
    });
  } catch (err) {
    console.error("❌ [Booking] Failed to update booking in DB", {
      requestId,
      slug,
      error: err
    });
    // Calendar event is already updated; continue anyway
  }

  // Confirmation email for update (same rules as create)
  let confirmationEmailSent: boolean | undefined;
  let confirmationEmailError: string | undefined;

  if (confirmationEmailEnabled) {
    try {
      const emailArgs: BookAppointmentArgs = {
        name: existing.name,
        email: existing.email,
        phone: existing.phone || "",
        service: args.service ?? existing.service,
        datetime: newStart.toISO()!
      };

      const emailResult = await sendBookingConfirmationEmail({
        botId: botConfig.botId ?? null,
        botName: botConfig.name,
        botDomain: botConfig.domain || null,
        bookingCfg,
        args: emailArgs,
        start: newStart,
        end: newEnd,
        addToCalendarUrl
      });

      confirmationEmailSent = emailResult.sent;
      if (!emailResult.sent && emailResult.reason) {
        confirmationEmailError = emailResult.reason;
      }
    } catch (err) {
      console.error("❌ [Booking] Failed to send update confirmation email", {
        requestId,
        slug,
        error: err
      });
      confirmationEmailSent = false;
      confirmationEmailError = "internal_error";
    }
  }

  console.log("✅ [Booking] Booking updated", {
    requestId,
    slug,
    bookingId: existing.id
  });

  return {
    success: true,
    action: "updated",
    start: newStart.toISO(),
    end: newEnd.toISO(),
    addToCalendarUrl,
    confirmationEmailSent,
    confirmationEmailError
  };
}

/**
 * Cancel an existing booking, identified by email + original datetime.
 * Now implemented as a SOFT delete (status = CANCELLED).
 */
export async function handleCancelAppointment(
  slug: string,
  args: CancelAppointmentArgs
): Promise<BookingResult> {
  const requestId = nextBookingRequestId();
  console.log("📅 [Booking] Incoming cancel request", {
    requestId,
    slug,
    args
  });

  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    return {
      success: false,
      action: "cancelled",
      errorMessage: "Bot not found for this booking."
    };
  }

  const bookingCfg = normalizeBookingConfig(botConfig.booking);
  if (!bookingCfg) {
    return {
      success: false,
      action: "cancelled",
      errorMessage: "Booking is not enabled for this bot."
    };
  }

  const timeZone = bookingCfg.timeZone;

  if (!args.email || !args.originalDatetime) {
    return {
      success: false,
      action: "cancelled",
      errorMessage:
        "To cancel a booking I need your email and the original date/time."
    };
  }

  const original = DateTime.fromISO(args.originalDatetime, { zone: timeZone });
  if (!original.isValid) {
    return {
      success: false,
      action: "cancelled",
      errorMessage:
        "The original date/time you provided is not a valid format. Please try again."
    };
  }

  const existing = await findBookingByEmailAndApproxTime({
    botId: botConfig.botId ?? null,
    email: args.email,
    approxStart: original
  });

  if (!existing) {
    console.warn("📅 [Booking] Cancel rejected - existing booking not found", {
      requestId,
      slug,
      email: args.email,
      original: args.originalDatetime
    });
    return {
      success: false,
      action: "cancelled",
      errorMessage:
        "I couldn't find an existing booking with that email and date/time. Please check your details."
    };
  }

  // Remove calendar event if present
  try {
    if (existing.calendarEventId && existing.calendarId) {
      await deleteCalendarEvent({
        calendarId: existing.calendarId,
        eventId: existing.calendarEventId
      });
    }
  } catch (err) {
    console.error("❌ [Booking] Failed to delete calendar event", {
      requestId,
      slug,
      error: err
    });
    return {
      success: false,
      action: "cancelled",
      errorMessage:
        "We couldn't cancel the appointment in the calendar due to an internal error."
    };
  }

  // Soft delete in DB: mark as CANCELLED instead of deleting
  try {
    await prisma.booking.update({
      where: { id: existing.id },
      data: {
        status: "CANCELLED"
      }
    });
  } catch (err) {
    console.error("❌ [Booking] Failed to update booking status in DB", {
      requestId,
      slug,
      error: err
    });
    return {
      success: false,
      action: "cancelled",
      errorMessage:
        "We cancelled the calendar event, but failed to update the booking record."
    };
  }

  console.log("✅ [Booking] Booking cancelled (soft-delete)", {
    requestId,
    slug,
    bookingId: existing.id
  });

  // Send cancellation email (gated by same email flag)
  let confirmationEmailSent: boolean | undefined;
  let confirmationEmailError: string | undefined;

  if (bookingCfg.confirmationEmailEnabled) {
    try {
      const start = DateTime.fromJSDate(existing.start).setZone(timeZone);
      const end = DateTime.fromJSDate(existing.end).setZone(timeZone);

      const emailArgs: BookAppointmentArgs = {
        name: existing.name,
        email: existing.email,
        phone: existing.phone || "",
        service: existing.service,
        datetime: start.toISO()!
      };

      const emailResult = await sendBookingCancellationEmail({
        botId: botConfig.botId ?? null,
        botName: botConfig.name,
        botDomain: botConfig.domain || null,
        bookingCfg,
        args: emailArgs,
        start,
        end,
        reason: args.reason
      });

      confirmationEmailSent = emailResult.sent;
      if (!emailResult.sent && emailResult.reason) {
        confirmationEmailError = emailResult.reason;
      }
    } catch (err) {
      console.error("❌ [Booking] Failed to send cancellation email", {
        requestId,
        slug,
        error: err
      });
      confirmationEmailSent = false;
      confirmationEmailError = "internal_error";
    }
  }

  return {
    success: true,
    action: "cancelled",
    start: existing.start.toISOString(),
    end: existing.end.toISOString(),
    confirmationEmailSent,
    confirmationEmailError
  };
}

/**
 * Find a booking by email and approximate start time (±30 minutes window).
 * Only returns ACTIVE bookings (soft delete aware).
 */
async function findBookingByEmailAndApproxTime(params: {
  botId: string | null;
  email: string;
  approxStart: DateTime;
}): Promise<any | null> {
  if (!params.botId) return null;

  const from = params.approxStart.minus({ minutes: 30 }).toJSDate();
  const to = params.approxStart.plus({ minutes: 30 }).toJSDate();

  return prisma.booking.findFirst({
    where: {
      botId: params.botId,
      email: params.email,
      status: "ACTIVE",
      start: {
        gte: from,
        lte: to
      }
    },
    orderBy: { start: "asc" }
  });
}

function buildUpdateEventDescription(existing: any): string {
  const lines: string[] = [
    `Service: ${existing.service}`,
    `Name: ${existing.name}`,
    `Email: ${existing.email}`,
    `Phone: ${existing.phone || "(not provided)"}`
  ];
  return lines.join("\n");
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

type SendBookingCancellationEmailResult = {
  sent: boolean;
  reason?: string;
};

async function sendBookingCancellationEmail(params: {
  botId: string | null;
  botName: string;
  botDomain: string | null;
  bookingCfg: NormalizedBookingConfig;
  args: BookAppointmentArgs;
  start: DateTime;
  end: DateTime;
  reason?: string;
}): Promise<SendBookingCancellationEmailResult> {
  const { botId, botName, botDomain, bookingCfg, args, start, reason } = params;

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
    reason: reason || ""
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
    reason: escapeHtml(reason || "")
  };

  const subjectTemplate =
    bookingCfg.cancellationSubjectTemplate ||
    "Your {{service}} booking on {{date}} at {{time}} with {{brandName}} has been cancelled";

  const defaultText =
    `Hi {{name}},\n\n` +
    `Your booking with {{brandName}} has been cancelled.\n\n` +
    `Service: {{service}}\n` +
    `Date: {{date}}\n` +
    `Time: {{time}} ({{timezone}})\n\n` +
    `Reason: {{reason}}\n\n` +
    `If this was a mistake or you would like to reschedule, please contact us or book a new time.\n\n` +
    `Thank you!`;

  const textTemplate =
    bookingCfg.cancellationBodyTextTemplate || defaultText;

  const defaultHtml =
    `<p>Hi {{name}},</p>` +
    `<p>Your booking with <strong>{{brandName}}</strong> has been <strong>cancelled</strong>.</p>` +
    `<p>` +
    `<strong>Service:</strong> {{service}}<br>` +
    `<strong>Date:</strong> {{date}}<br>` +
    `<strong>Time:</strong> {{time}} ({{timezone}})` +
    `</p>` +
    `<p><strong>Reason:</strong> {{reason}}</p>` +
    `<p>If this was a mistake or you would like to reschedule, please contact us or book a new time.</p>` +
    `<p>Thank you!</p>`;

  const htmlTemplate =
    bookingCfg.cancellationBodyHtmlTemplate || defaultHtml;

  const subject = renderTemplate(subjectTemplate, contextText);
  const text = renderTemplate(textTemplate, contextText);
  const html = renderTemplate(htmlTemplate, contextHtml);

  const sendResult = await sendBotMail({
    botId,
    kind: "booking_cancellation",
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
