// google/calendar.ts

import { google } from "googleapis";
import { config } from "../config";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

let calendarClient: ReturnType<typeof google.calendar> | null = null;

function getCalendarClient() {
  if (calendarClient) return calendarClient;

  if (!config.googleClientEmail || !config.googlePrivateKey) {
    throw new Error(
      "Google Calendar is not configured (missing service account envs)"
    );
  }

  const privateKey = config.googlePrivateKey.replace(/\\n/g, "\n");

  const jwt = new google.auth.JWT({
    email: config.googleClientEmail,
    key: privateKey,
    scopes: SCOPES
  });

  calendarClient = google.calendar({ version: "v3", auth: jwt });
  return calendarClient;
}

export interface CreateBookingParams {
  calendarId: string;
  summary: string;
  description?: string;
  start: string; // ISO
  end: string; // ISO
  timeZone: string;
}

export async function createCalendarEvent(
  params: CreateBookingParams
): Promise<{
  id: string;
  htmlLink?: string;
  start: string;
  end: string;
}> {
  const calendar = getCalendarClient();

  const response = await calendar.events.insert({
    calendarId: params.calendarId,
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: {
        dateTime: params.start,
        timeZone: params.timeZone
      },
      end: {
        dateTime: params.end,
        timeZone: params.timeZone
      }
    }
  });

  const event = response.data;
  if (!event || !event.id || !event.start || !event.end) {
    throw new Error("Invalid response from Google Calendar when creating event");
  }

  return {
    id: event.id,
    htmlLink: event.htmlLink || undefined,
    start: (event.start.dateTime || event.start.date)!,
    end: (event.end.dateTime || event.end.date)!
  };
}

// Optional simple conflict checker (kept for backwards-compat, no longer used by bookingService)
export async function checkConflicts(params: {
  calendarId: string;
  timeMin: string;
  timeMax: string;
}): Promise<boolean> {
  const calendar = getCalendarClient();

  const res = await calendar.events.list({
    calendarId: params.calendarId,
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    singleEvents: true,
    maxResults: 1
  });

  const events = res.data.items || [];
  return events.length > 0;
}

/**
 * Count how many events exist in a given time range.
 * We allow passing maxResults so we don't fetch more than needed
 * for simultaneous slot capacity checks.
 */
export async function countEventsInRange(params: {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<number> {
  const calendar = getCalendarClient();

  const res = await calendar.events.list({
    calendarId: params.calendarId,
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    singleEvents: true,
    maxResults: params.maxResults
  });

  const events = res.data.items || [];
  return events.length;
}

export interface UpdateCalendarEventParams {
  calendarId: string;
  eventId: string;
  summary?: string;
  description?: string;
  start?: string; // ISO
  end?: string; // ISO
  timeZone?: string;
}

/**
 * Update an existing Google Calendar event.
 */
export async function updateCalendarEvent(
  params: UpdateCalendarEventParams
): Promise<{ id: string; start: string; end: string }> {
  const calendar = getCalendarClient();

  const response = await calendar.events.patch({
    calendarId: params.calendarId,
    eventId: params.eventId,
    requestBody: {
      summary: params.summary,
      description: params.description,
      start:
        params.start && params.timeZone
          ? { dateTime: params.start, timeZone: params.timeZone }
          : undefined,
      end:
        params.end && params.timeZone
          ? { dateTime: params.end, timeZone: params.timeZone }
          : undefined
    }
  });

  const event = response.data;
  if (!event || !event.id || !event.start || !event.end) {
    throw new Error(
      "Invalid response from Google Calendar when updating event"
    );
  }

  return {
    id: event.id,
    start: (event.start.dateTime || event.start.date)!,
    end: (event.end.dateTime || event.end.date)!
  };
}

/**
 * Delete a Google Calendar event.
 */
export async function deleteCalendarEvent(params: {
  calendarId: string;
  eventId: string;
}): Promise<void> {
  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: params.calendarId,
    eventId: params.eventId
  });
}
