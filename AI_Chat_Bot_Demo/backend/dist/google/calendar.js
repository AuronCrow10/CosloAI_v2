"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCalendarEvent = createCalendarEvent;
exports.checkConflicts = checkConflicts;
const googleapis_1 = require("googleapis");
const config_1 = require("../config");
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
let calendarClient = null;
function getCalendarClient() {
    if (calendarClient)
        return calendarClient;
    if (!config_1.config.googleClientEmail || !config_1.config.googlePrivateKey) {
        throw new Error("Google Calendar is not configured (missing service account envs)");
    }
    const privateKey = config_1.config.googlePrivateKey.replace(/\\n/g, "\n");
    const jwt = new googleapis_1.google.auth.JWT({
        email: config_1.config.googleClientEmail,
        key: privateKey,
        scopes: SCOPES
    });
    calendarClient = googleapis_1.google.calendar({ version: "v3", auth: jwt });
    return calendarClient;
}
async function createCalendarEvent(params) {
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
        start: (event.start.dateTime || event.start.date),
        end: (event.end.dateTime || event.end.date)
    };
}
// Optional simple conflict checker (v1 can skip if you want)
async function checkConflicts(params) {
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
