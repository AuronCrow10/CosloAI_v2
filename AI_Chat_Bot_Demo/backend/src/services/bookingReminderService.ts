// services/bookingReminderService.ts

import { DateTime } from "luxon";
import { prisma } from "../prisma/prisma";
import { sendBotMail } from "./mailer";

const JOB_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
let isRunning = false;

export function scheduleBookingReminderJob(): void {
  console.log("[BookingReminder] Scheduling booking reminder job...");

  // Run once on startup
  runJobSafely();

  // Then periodically
  setInterval(runJobSafely, JOB_INTERVAL_MS);
}

async function runJobSafely(): Promise<void> {
  if (isRunning) {
    console.log("[BookingReminder] Previous run still in progress, skipping.");
    return;
  }

  isRunning = true;
  const startedAt = new Date();

  try {
    await runBookingReminderJob();
  } catch (err) {
    console.error("[BookingReminder] Error in reminder job", { error: err });
  } finally {
    isRunning = false;
    const finishedAt = new Date();
    console.log("[BookingReminder] Job cycle completed", {
      startedAt,
      finishedAt
    });
  }
}

async function runBookingReminderJob(): Promise<void> {
  const nowUtc = DateTime.utc();
  const in48HoursUtc = nowUtc.plus({ hours: 48 });

  console.log("[BookingReminder] Running job", {
    nowUtc: nowUtc.toISO(),
    untilUtc: in48HoursUtc.toISO()
  });

  // Fetch bookings in the next 48 hours that haven't had a reminder sent yet.
  // Include the related Bot so we can access booking + email config.
  const bookings = await prisma.booking.findMany({
    where: {
      start: {
        gte: nowUtc.toJSDate(),
        lt: in48HoursUtc.toJSDate()
      },
      reminderEmailSentAt: null
    },
    orderBy: {
      start: "asc"
    },
    include: {
      bot: true
    }
  });

  if (bookings.length === 0) {
    console.log("[BookingReminder] No candidate bookings found.");
    return;
  }

  console.log("[BookingReminder] Candidate bookings found", {
    count: bookings.length
  });

  for (const booking of bookings) {
    try {
      await maybeSendReminderForBooking(booking);
    } catch (err) {
      console.error("[BookingReminder] Error handling booking", {
        bookingId: booking.id,
        error: err
      });
    }
  }
}

async function maybeSendReminderForBooking(booking: any): Promise<void> {
  if (!booking.email) {
    console.warn("[BookingReminder] Booking missing email, skipping.", {
      bookingId: booking.id
    });
    return;
  }

  if (!booking.timeZone) {
    console.warn("[BookingReminder] Booking missing timeZone, skipping.", {
      bookingId: booking.id
    });
    return;
  }

  const bot = booking.bot;
  if (!bot) {
    console.warn("[BookingReminder] Booking missing bot relation, skipping.", {
      bookingId: booking.id
    });
    return;
  }

  // If reminders are disabled for this bot, skip
  if (bot.bookingReminderEmailEnabled === false) {
    return;
  }

  const nowLocal = DateTime.now().setZone(booking.timeZone);
  const startLocal = DateTime.fromJSDate(booking.start).setZone(
    booking.timeZone
  );
  const createdLocal = DateTime.fromJSDate(booking.createdAt).setZone(
    booking.timeZone
  );

  if (!startLocal.isValid) {
    console.warn("[BookingReminder] Invalid start date for booking, skipping.", {
      bookingId: booking.id,
      start: booking.start
    });
    return;
  }

  // Past or ongoing bookings – no reminder.
  if (startLocal <= nowLocal) {
    return;
  }

  // Bot-specific reminder timing config (with sensible defaults)
  const reminderWindowHours: number =
    typeof bot.bookingReminderWindowHours === "number" &&
    bot.bookingReminderWindowHours > 0
      ? bot.bookingReminderWindowHours
      : 12;

  const minLeadHours: number =
    typeof bot.bookingReminderMinLeadHours === "number" &&
    bot.bookingReminderMinLeadHours > 0
      ? bot.bookingReminderMinLeadHours
      : 18;

  const hoursUntilStart = startLocal.diff(nowLocal, "hours").hours;
  const hoursFromCreationToStart = startLocal
    .diff(createdLocal, "hours")
    .hours;

  // Only send reminders when we are inside the configured reminder window
  if (hoursUntilStart > reminderWindowHours) {
    return;
  }

  // Only send reminders if the booking was made long enough in advance
  if (hoursFromCreationToStart < minLeadHours) {
    return;
  }

  // ---- Bot-specific branding ----
  const brandName: string = bot.name || "our business";
  const brandUrl: string = bot.domain || "";

  const startLocalDateStr = startLocal.toFormat("cccc, dd LLLL yyyy");
  const startLocalTimeStr = startLocal.toFormat("HH:mm");

  const subjectTemplate =
    bot.bookingReminderSubjectTemplate ||
    `Reminder: your {{service}} booking today at {{time}} with {{brandName}}`;

  const defaultText =
    `Hi {{name}},\n\n` +
    `This is a reminder from {{brandName}} for your {{service}} booking on {{date}} at {{time}} ({{timezone}}).\n\n` +
    `If you need to reschedule, please contact us.\n\n` +
    `See you soon!`;

  const textTemplate =
    bot.bookingReminderBodyTextTemplate || defaultText;

  const defaultHtml =
    `<p>Hi {{name}},</p>` +
    `<p>This is a reminder from <strong>{{brandName}}</strong> for your ` +
    `<strong>{{service}}</strong> booking on <strong>{{date}}</strong> at ` +
    `<strong>{{time}}</strong> ({{timezone}}).</p>` +
    `<p>If you need to reschedule, please contact us.</p>` +
    `<p>See you soon!</p>`;

  const htmlTemplate =
    bot.bookingReminderBodyHtmlTemplate || defaultHtml;

  const contextText: Record<string, string> = {
    name: booking.name,
    email: booking.email,
    phone: booking.phone || "",
    service: booking.service,
    date: startLocalDateStr,
    time: startLocalTimeStr,
    timezone: booking.timeZone,
    brandName,
    brandUrl
  };

  const contextHtml: Record<string, string> = {
    name: escapeHtml(booking.name),
    email: escapeHtml(booking.email),
    phone: escapeHtml(booking.phone || ""),
    service: escapeHtml(booking.service),
    date: escapeHtml(startLocalDateStr),
    time: escapeHtml(startLocalTimeStr),
    timezone: escapeHtml(booking.timeZone),
    brandName: escapeHtml(brandName),
    brandUrl: escapeHtml(brandUrl)
  };

  const subject = renderTemplate(subjectTemplate, contextText);
  const text = renderTemplate(textTemplate, contextText);
  const html = renderTemplate(htmlTemplate, contextHtml);

  console.log("[BookingReminder] Sending reminder email", {
    bookingId: booking.id,
    to: booking.email,
    brandName,
    reminderWindowHours,
    minLeadHours
  });

  const sendResult = await sendBotMail({
    botId: booking.botId,
    kind: "booking_reminder",
    to: booking.email,
    subject,
    text,
    html
  });

  if (!sendResult.sent) {
    console.warn("[BookingReminder] Reminder email not sent", {
      bookingId: booking.id,
      reason: sendResult.reason
    });
    // We intentionally DO NOT mark reminderEmailSentAt on failure,
    // so we may retry in a future cycle. This is a tradeoff between
    // reliability and noise/log volume.
    return;
  }

  // Mark reminder as sent
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      reminderEmailSentAt: new Date()
    }
  });

  console.log("[BookingReminder] Reminder sent and booking updated", {
    bookingId: booking.id
  });
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
