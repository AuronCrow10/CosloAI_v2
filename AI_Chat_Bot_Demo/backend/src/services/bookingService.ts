import { DateTime } from "luxon";
import { getBotConfigBySlug } from "../bots/config";
import { createCalendarEvent, checkConflicts } from "../google/calendar";

export interface BookAppointmentArgs {
  name: string;
  phone: string;
  service: string;
  datetime: string; // ISO-like string from the tool
}

export interface BookingResult {
  success: boolean;
  start?: string;
  end?: string;
  htmlLink?: string;
  errorMessage?: string;
}

let bookingRequestCounter = 0;
function nextBookingRequestId(): string {
  bookingRequestCounter += 1;
  return bookingRequestCounter.toString().padStart(4, "0");
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

  const bot = await getBotConfigBySlug(slug);
  if (!bot || !bot.booking || !bot.booking.enabled) {
    const result: BookingResult = {
      success: false,
      errorMessage: "Booking is not enabled for this bot."
    };
    console.warn("📅 [Booking] Rejected - booking disabled", {
      requestId,
      slug
    });
    return result;
  }

  if (bot.booking.provider !== "google_calendar") {
    const result: BookingResult = {
      success: false,
      errorMessage: "Unsupported booking provider."
    };
    console.warn("📅 [Booking] Rejected - unsupported provider", {
      requestId,
      slug,
      provider: bot.booking.provider
    });
    return result;
  }

  const { calendarId, timeZone, defaultDurationMinutes } = bot.booking;

  // Basic arguments validation
  if (!args.name || !args.phone || !args.service || !args.datetime) {
    const result: BookingResult = {
      success: false,
      errorMessage: "Missing required booking fields."
    };
    console.warn("📅 [Booking] Rejected - missing fields", {
      requestId,
      slug,
      missing: {
        name: !args.name,
        phone: !args.phone,
        service: !args.service,
        datetime: !args.datetime
      }
    });
    return result;
  }

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
      errorMessage: "The requested time is in the past. Please choose another time."
    };
    console.warn("📅 [Booking] Rejected - time in the past", {
      requestId,
      slug,
      requested: start.toISO(),
      now: now.toISO()
    });
    return result;
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
    const description = `Service: ${args.service}\nName: ${args.name}\nPhone: ${args.phone}`;

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

    const result: BookingResult = {
      success: true,
      start: event.start,
      end: event.end,
      htmlLink: event.htmlLink
    };

    console.log("✅ [Booking] Event created successfully", {
      requestId,
      slug,
      calendarId,
      eventId: event.id,
      start: event.start,
      end: event.end,
      htmlLink: event.htmlLink
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
