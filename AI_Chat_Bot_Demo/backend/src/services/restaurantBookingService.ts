import crypto from "crypto";
import { DateTime } from "luxon";
import { prisma } from "../prisma/prisma";
import { sendBotMail } from "./mailer";

type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

type RestaurantOpeningWindow = {
  start: string;
  end: string;
};

export type RestaurantOpeningHours = Partial<
  Record<WeekdayKey, RestaurantOpeningWindow[]>
>;

type RestaurantTableManualState =
  | "AUTO"
  | "FREE"
  | "RESERVED"
  | "OCCUPIED"
  | "OUT_OF_SERVICE";

type RestaurantReservationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CANCELLED"
  | "CHECKED_IN"
  | "COMPLETED"
  | "EXPIRED"
  | "NO_SHOW";

type RestaurantSmokingPreference = "NO_PREFERENCE" | "SMOKING" | "NON_SMOKING";

type RestaurantReservationSource = "AI" | "STAFF" | "CUSTOMER" | "SYSTEM";
type RestaurantReservationActor = "AI" | "STAFF" | "CUSTOMER" | "SYSTEM";

const BLOCKING_STATUSES: RestaurantReservationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN"
];

const DEFAULT_DURATION_MINUTES = 90;
const DEFAULT_BUFFER_MINUTES = 15;
const DEFAULT_SATURATION_PCT = 85;
const DEFAULT_OVERSIZE_TOLERANCE = 2;
const DEFAULT_MAX_JOINED_TABLES = 2;
const DEFAULT_LATE_ARRIVAL_GRACE_MINUTES = 15;
const DEFAULT_NO_SHOW_AFTER_MINUTES = 30;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESTAURANT_TABLE_OVERLAP_CONSTRAINT =
  "RestaurantReservationTable_tableId_block_window_excl";

const db = prisma as any;

export type RestaurantChatCreateArgs = {
  name: string;
  email: string;
  phone: string;
  partySize: number;
  datetime: string;
  smokingPreference?: "smoking" | "non_smoking" | "no_preference";
  notes?: string;
};

export type RestaurantChatCancelArgs = {
  email: string;
  datetime: string;
  reason?: string;
};

export type RestaurantChatResult = {
  success: boolean;
  action?: "created" | "cancelled";
  errorCode?: string;
  errorMessage?: string;
  reservationId?: string;
  start?: string;
  end?: string;
  assignedTables?: string[];
  partySize?: number;
  checkInUrl?: string;
  confirmationEmailSent?: boolean;
  confirmationEmailError?: string;
  thresholdTriggered?: boolean;
  saturationPercent?: number;
};

export type RestaurantRulesInput = {
  timeZone?: string | null;
  openingHours?: RestaurantOpeningHours | null;
  closedDates?: string[] | null;
  defaultDurationMinutes?: number | null;
  bufferMinutes?: number | null;
  autoBookingSaturationPct?: number | null;
  oversizeToleranceSeats?: number | null;
  allowJoinedTables?: boolean | null;
  joinedTablesFallbackOnly?: boolean | null;
  maxJoinedTables?: number | null;
  lateArrivalGraceMinutes?: number | null;
  noShowAfterMinutes?: number | null;
};

export type RestaurantRoomInput = {
  id?: string;
  name: string;
  notes?: string | null;
  displayOrder?: number | null;
  isActive?: boolean;
  tables: Array<{
    id?: string;
    code: string;
    capacity: number;
    isSmoking?: boolean;
    notes?: string | null;
    isAiBookable?: boolean;
    isActive?: boolean;
  }>;
};

export type RestaurantJoinInput = {
  id?: string;
  name: string;
  isActive?: boolean;
  allowAiBooking?: boolean;
  tableIds: string[];
};

export type RestaurantSetupInput = {
  rules?: RestaurantRulesInput;
  rooms: RestaurantRoomInput[];
  joins: RestaurantJoinInput[];
};

export class RestaurantSetupValidationError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(params: {
    code: string;
    message: string;
    statusCode?: number;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "RestaurantSetupValidationError";
    this.code = params.code;
    this.statusCode = params.statusCode ?? 400;
    this.details = params.details;
  }
}

type RestaurantRulesResolved = {
  timeZone: string;
  openingHours: RestaurantOpeningHours | null;
  closedDates: Set<string>;
  defaultDurationMinutes: number;
  bufferMinutes: number;
  autoBookingSaturationPct: number;
  oversizeToleranceSeats: number;
  allowJoinedTables: boolean;
  joinedTablesFallbackOnly: boolean;
  maxJoinedTables: number;
  lateArrivalGraceMinutes: number;
  noShowAfterMinutes: number;
};

export type RestaurantAssignmentTable = {
  id: string;
  botId: string;
  roomId: string;
  code: string;
  capacity: number;
  isSmoking: boolean;
  isAiBookable: boolean;
  isActive: boolean;
  manualState: RestaurantTableManualState;
};

export type RestaurantJoinOption = {
  id: string;
  name: string;
  isActive: boolean;
  allowAiBooking: boolean;
  tableIds: string[];
};

export type RestaurantReservationSlice = {
  botId: string;
  status: RestaurantReservationStatus;
  startAt: DateTime;
  endAt: DateTime;
  bufferMinutes: number;
  tableIds: string[];
};

export type RestaurantAssignmentCandidate = {
  tableIds: string[];
  tableCodes: string[];
  totalCapacity: number;
  wastedSeats: number;
  maxTableCapacity: number;
  joined: boolean;
  exactFit: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function computeReservationAllocationWindow(params: {
  startAt: Date | string;
  endAt: Date | string;
  bufferMinutes: number;
}): { blockedFrom: Date; blockedUntil: Date } {
  const startAt =
    params.startAt instanceof Date ? params.startAt : new Date(params.startAt);
  const endAt = params.endAt instanceof Date ? params.endAt : new Date(params.endAt);
  const bufferMinutes = Math.max(0, Math.floor(Number(params.bufferMinutes || 0)));
  const blockedFrom = new Date(startAt.getTime() - bufferMinutes * 60_000);
  const blockedUntil = new Date(endAt.getTime() + bufferMinutes * 60_000);
  return { blockedFrom, blockedUntil };
}

export function isRestaurantAllocationOverlapDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as any;
  const message = String(maybe?.message || "");
  const databaseError = String(maybe?.meta?.database_error || "");
  const target = maybe?.meta?.target;
  const targetText = Array.isArray(target) ? target.join(",") : String(target || "");
  return (
    message.includes(RESTAURANT_TABLE_OVERLAP_CONSTRAINT) ||
    databaseError.includes(RESTAURANT_TABLE_OVERLAP_CONSTRAINT) ||
    targetText.includes(RESTAURANT_TABLE_OVERLAP_CONSTRAINT)
  );
}

export function isRestaurantTableCodeUniqueDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as any;
  if (String(maybe?.code || "") !== "P2002") return false;
  const modelName = String(maybe?.meta?.modelName || "");
  if (modelName && modelName !== "RestaurantTable") return false;

  const target = maybe?.meta?.target;
  const targetParts = Array.isArray(target)
    ? target.map((x: unknown) => String(x))
    : String(target || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  return targetParts.includes("code") &&
    (targetParts.includes("roomId") || targetParts.includes("botId"));
}

export function assertUniqueRestaurantTableCodesPerRoom(
  rooms: RestaurantRoomInput[]
): void {
  const duplicates: Array<{ roomName: string; code: string }> = [];

  for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
    const room = rooms[roomIndex];
    const roomName = String(room?.name || "").trim() || `Room ${roomIndex + 1}`;
    const seen = new Set<string>();

    for (const table of room?.tables || []) {
      const code = String(table?.code || "").trim();
      if (!code) continue;
      const key = code.toLowerCase();
      if (seen.has(key)) {
        duplicates.push({ roomName, code });
      } else {
        seen.add(key);
      }
    }
  }

  if (duplicates.length > 0) {
    throw new RestaurantSetupValidationError({
      code: "duplicate_table_code_in_room",
      message:
        "Each table code must be unique within the same room. Duplicate table codes were found.",
      details: { duplicates }
    });
  }
}

function parseTimeToMinutes(value: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hRaw, mRaw] = value.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function weekdayKey(dt: DateTime): WeekdayKey {
  const keys: WeekdayKey[] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday"
  ];
  return keys[dt.weekday - 1];
}

function normalizeSmokingPreference(
  value?: string
): RestaurantSmokingPreference {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "smoking") return "SMOKING";
  if (normalized === "non_smoking") return "NON_SMOKING";
  return "NO_PREFERENCE";
}

function asDateTime(value: Date | string, zone: string): DateTime {
  if (value instanceof Date) return DateTime.fromJSDate(value).setZone(zone);
  return DateTime.fromISO(String(value), { zone });
}

function toClosedDate(dt: DateTime): string {
  return dt.toFormat("yyyy-LL-dd");
}

function defaultRestaurantRules(timeZone: string): RestaurantRulesResolved {
  return {
    timeZone,
    openingHours: null,
    closedDates: new Set<string>(),
    defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
    bufferMinutes: DEFAULT_BUFFER_MINUTES,
    autoBookingSaturationPct: DEFAULT_SATURATION_PCT,
    oversizeToleranceSeats: DEFAULT_OVERSIZE_TOLERANCE,
    allowJoinedTables: true,
    joinedTablesFallbackOnly: true,
    maxJoinedTables: DEFAULT_MAX_JOINED_TABLES,
    lateArrivalGraceMinutes: DEFAULT_LATE_ARRIVAL_GRACE_MINUTES,
    noShowAfterMinutes: DEFAULT_NO_SHOW_AFTER_MINUTES
  };
}

function parseOpeningHours(value: unknown): RestaurantOpeningHours | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const out: RestaurantOpeningHours = {};

  const keys: WeekdayKey[] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday"
  ];

  for (const key of keys) {
    const dayValue = input[key];
    if (!Array.isArray(dayValue)) continue;
    const windows: RestaurantOpeningWindow[] = [];
    for (const item of dayValue) {
      if (!item || typeof item !== "object") continue;
      const start = String((item as any).start || "").trim();
      const end = String((item as any).end || "").trim();
      if (parseTimeToMinutes(start) == null || parseTimeToMinutes(end) == null) {
        continue;
      }
      if ((parseTimeToMinutes(start) || 0) >= (parseTimeToMinutes(end) || 0)) {
        continue;
      }
      windows.push({ start, end });
    }
    if (windows.length > 0) out[key] = windows;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function resolveRules(rawConfig: any, botTimeZone: string): RestaurantRulesResolved {
  const defaults = defaultRestaurantRules(botTimeZone);
  if (!rawConfig) return defaults;

  const closedDatesRaw = Array.isArray(rawConfig.closedDates)
    ? rawConfig.closedDates
    : [];
  const closedDates = new Set<string>();
  for (const d of closedDatesRaw) {
    const v = String(d || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      closedDates.add(v);
    }
  }

  return {
    timeZone:
      typeof rawConfig.timeZone === "string" && rawConfig.timeZone.trim()
        ? rawConfig.timeZone.trim()
        : defaults.timeZone,
    openingHours: parseOpeningHours(rawConfig.openingHours) || null,
    closedDates,
    defaultDurationMinutes:
      typeof rawConfig.defaultDurationMinutes === "number" &&
      rawConfig.defaultDurationMinutes > 0
        ? Math.floor(rawConfig.defaultDurationMinutes)
        : defaults.defaultDurationMinutes,
    bufferMinutes:
      typeof rawConfig.bufferMinutes === "number" && rawConfig.bufferMinutes >= 0
        ? Math.floor(rawConfig.bufferMinutes)
        : defaults.bufferMinutes,
    autoBookingSaturationPct:
      typeof rawConfig.autoBookingSaturationPct === "number"
        ? clamp(Math.floor(rawConfig.autoBookingSaturationPct), 1, 100)
        : defaults.autoBookingSaturationPct,
    oversizeToleranceSeats:
      typeof rawConfig.oversizeToleranceSeats === "number" &&
      rawConfig.oversizeToleranceSeats >= 0
        ? Math.floor(rawConfig.oversizeToleranceSeats)
        : defaults.oversizeToleranceSeats,
    allowJoinedTables:
      typeof rawConfig.allowJoinedTables === "boolean"
        ? rawConfig.allowJoinedTables
        : defaults.allowJoinedTables,
    joinedTablesFallbackOnly:
      typeof rawConfig.joinedTablesFallbackOnly === "boolean"
        ? rawConfig.joinedTablesFallbackOnly
        : defaults.joinedTablesFallbackOnly,
    maxJoinedTables:
      typeof rawConfig.maxJoinedTables === "number" && rawConfig.maxJoinedTables > 0
        ? Math.floor(rawConfig.maxJoinedTables)
        : defaults.maxJoinedTables,
    lateArrivalGraceMinutes:
      typeof rawConfig.lateArrivalGraceMinutes === "number" &&
      rawConfig.lateArrivalGraceMinutes >= 0
        ? Math.floor(rawConfig.lateArrivalGraceMinutes)
        : defaults.lateArrivalGraceMinutes,
    noShowAfterMinutes:
      typeof rawConfig.noShowAfterMinutes === "number" &&
      rawConfig.noShowAfterMinutes >= 0
        ? Math.floor(rawConfig.noShowAfterMinutes)
        : defaults.noShowAfterMinutes
  };
}

export function isReservationWithinOpeningHours(params: {
  start: DateTime;
  end: DateTime;
  openingHours: RestaurantOpeningHours | null;
  closedDates: Set<string>;
}): boolean {
  const { start, end, openingHours, closedDates } = params;
  if (closedDates.has(toClosedDate(start))) return false;
  if (start.startOf("day").toISODate() !== end.startOf("day").toISODate()) {
    return false;
  }
  if (!openingHours) return true;

  const day = weekdayKey(start);
  const windows = openingHours[day];
  if (!windows || windows.length === 0) return false;

  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  return windows.some((w) => {
    const from = parseTimeToMinutes(w.start);
    const to = parseTimeToMinutes(w.end);
    if (from == null || to == null) return false;
    return startMin >= from && endMin <= to;
  });
}

function reservationBlocksInterval(params: {
  reservationStart: DateTime;
  reservationEnd: DateTime;
  reservationBufferMinutes: number;
  candidateStart: DateTime;
  candidateEnd: DateTime;
  candidateBufferMinutes: number;
}): boolean {
  const {
    reservationStart,
    reservationEnd,
    reservationBufferMinutes,
    candidateStart,
    candidateEnd,
    candidateBufferMinutes
  } = params;

  const existingFrom = reservationStart.minus({ minutes: reservationBufferMinutes });
  const existingTo = reservationEnd.plus({ minutes: reservationBufferMinutes });
  const candidateFrom = candidateStart.minus({ minutes: candidateBufferMinutes });
  const candidateTo = candidateEnd.plus({ minutes: candidateBufferMinutes });
  return existingFrom < candidateTo && existingTo > candidateFrom;
}

function tableMatchesSmokingPreference(
  table: RestaurantAssignmentTable,
  smokingPreference: RestaurantSmokingPreference
): boolean {
  if (smokingPreference === "NO_PREFERENCE") return true;
  if (smokingPreference === "SMOKING") return table.isSmoking;
  return !table.isSmoking;
}

function buildSingleCandidates(params: {
  tables: RestaurantAssignmentTable[];
  partySize: number;
  oversizeToleranceSeats: number;
  smokingPreference: RestaurantSmokingPreference;
  includeAiOnly: boolean;
}): RestaurantAssignmentCandidate[] {
  const {
    tables,
    partySize,
    oversizeToleranceSeats,
    smokingPreference,
    includeAiOnly
  } = params;

  const maxCapacity = partySize + oversizeToleranceSeats;
  const out: RestaurantAssignmentCandidate[] = [];
  for (const table of tables) {
    if (!table.isActive) continue;
    if (includeAiOnly && !table.isAiBookable) continue;
    if (!tableMatchesSmokingPreference(table, smokingPreference)) continue;
    if (table.capacity < partySize) continue;
    if (table.capacity > maxCapacity) continue;
    out.push({
      tableIds: [table.id],
      tableCodes: [table.code],
      totalCapacity: table.capacity,
      wastedSeats: table.capacity - partySize,
      maxTableCapacity: table.capacity,
      joined: false,
      exactFit: table.capacity === partySize
    });
  }
  return out;
}

function buildJoinedCandidates(params: {
  tables: RestaurantAssignmentTable[];
  joins: RestaurantJoinOption[];
  partySize: number;
  oversizeToleranceSeats: number;
  smokingPreference: RestaurantSmokingPreference;
  includeAiOnly: boolean;
  maxJoinedTables: number;
}): RestaurantAssignmentCandidate[] {
  const {
    tables,
    joins,
    partySize,
    oversizeToleranceSeats,
    smokingPreference,
    includeAiOnly,
    maxJoinedTables
  } = params;

  const tableById = new Map<string, RestaurantAssignmentTable>(
    tables.map((t) => [t.id, t])
  );
  const maxCapacity = partySize + oversizeToleranceSeats;
  const out: RestaurantAssignmentCandidate[] = [];

  for (const join of joins) {
    if (!join.isActive) continue;
    const uniqueIds = Array.from(new Set(join.tableIds || []));
    if (uniqueIds.length < 2 || uniqueIds.length > maxJoinedTables) continue;

    const members: RestaurantAssignmentTable[] = [];
    let invalid = false;
    for (const id of uniqueIds) {
      const table = tableById.get(id);
      if (!table || !table.isActive) {
        invalid = true;
        break;
      }
      if (includeAiOnly && !table.isAiBookable) {
        invalid = true;
        break;
      }
      if (!tableMatchesSmokingPreference(table, smokingPreference)) {
        invalid = true;
        break;
      }
      members.push(table);
    }
    if (invalid) continue;

    const totalCapacity = members.reduce((sum, t) => sum + t.capacity, 0);
    if (totalCapacity < partySize || totalCapacity > maxCapacity) continue;

    out.push({
      tableIds: members.map((t) => t.id).sort(),
      tableCodes: members
        .map((t) => t.code)
        .sort((a, b) => a.localeCompare(b, "en")),
      totalCapacity,
      wastedSeats: totalCapacity - partySize,
      maxTableCapacity: members.reduce((max, t) => Math.max(max, t.capacity), 0),
      joined: true,
      exactFit: totalCapacity === partySize
    });
  }
  return out;
}

function compareAssignmentCandidates(
  a: RestaurantAssignmentCandidate,
  b: RestaurantAssignmentCandidate
): number {
  const rank = (x: RestaurantAssignmentCandidate): number => {
    if (!x.joined && x.exactFit) return 0;
    if (!x.joined && !x.exactFit) return 1;
    if (x.joined && x.exactFit) return 2;
    return 3;
  };

  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  if (a.wastedSeats !== b.wastedSeats) return a.wastedSeats - b.wastedSeats;
  if (a.maxTableCapacity !== b.maxTableCapacity) {
    return a.maxTableCapacity - b.maxTableCapacity;
  }
  if (a.tableIds.length !== b.tableIds.length) {
    return a.tableIds.length - b.tableIds.length;
  }
  return a.tableIds.join(",").localeCompare(b.tableIds.join(","), "en");
}

function candidateBlockedByManualState(
  candidate: RestaurantAssignmentCandidate,
  tableById: Map<string, RestaurantAssignmentTable>
): boolean {
  for (const tableId of candidate.tableIds) {
    const table = tableById.get(tableId);
    if (!table) return true;
    if (
      table.manualState === "OUT_OF_SERVICE" ||
      table.manualState === "RESERVED" ||
      table.manualState === "OCCUPIED"
    ) {
      return true;
    }
  }
  return false;
}

function candidateBlockedByReservations(params: {
  candidate: RestaurantAssignmentCandidate;
  reservations: RestaurantReservationSlice[];
  start: DateTime;
  end: DateTime;
  bufferMinutes: number;
}): boolean {
  const { candidate, reservations, start, end, bufferMinutes } = params;
  const candidateIds = new Set(candidate.tableIds);

  for (const reservation of reservations) {
    if (!BLOCKING_STATUSES.includes(reservation.status)) continue;
    const intersects = reservation.tableIds.some((id) => candidateIds.has(id));
    if (!intersects) continue;
    if (
      reservationBlocksInterval({
        reservationStart: reservation.startAt,
        reservationEnd: reservation.endAt,
        reservationBufferMinutes: reservation.bufferMinutes,
        candidateStart: start,
        candidateEnd: end,
        candidateBufferMinutes: bufferMinutes
      })
    ) {
      return true;
    }
  }
  return false;
}

export function chooseBestRestaurantAssignment(params: {
  tables: RestaurantAssignmentTable[];
  joins: RestaurantJoinOption[];
  reservations: RestaurantReservationSlice[];
  partySize: number;
  smokingPreference: RestaurantSmokingPreference;
  oversizeToleranceSeats: number;
  allowJoinedTables: boolean;
  joinedTablesFallbackOnly: boolean;
  maxJoinedTables: number;
  start: DateTime;
  end: DateTime;
  bufferMinutes: number;
  includeAiOnly: boolean;
}): RestaurantAssignmentCandidate | null {
  const {
    tables,
    joins,
    reservations,
    partySize,
    smokingPreference,
    oversizeToleranceSeats,
    allowJoinedTables,
    joinedTablesFallbackOnly,
    maxJoinedTables,
    start,
    end,
    bufferMinutes,
    includeAiOnly
  } = params;

  const reservationBotId = tables[0]?.botId;
  const relevantReservations =
    reservationBotId != null
      ? reservations.filter((r) => r.botId === reservationBotId)
      : reservations;

  const singles = buildSingleCandidates({
    tables,
    partySize,
    oversizeToleranceSeats,
    smokingPreference,
    includeAiOnly
  }).sort(compareAssignmentCandidates);

  const tableById = new Map<string, RestaurantAssignmentTable>(
    tables.map((t) => [t.id, t])
  );

  const freeSingles = singles.filter((candidate) => {
    if (candidateBlockedByManualState(candidate, tableById)) return false;
    if (
      candidateBlockedByReservations({
        candidate,
        reservations: relevantReservations,
        start,
        end,
        bufferMinutes
      })
    ) {
      return false;
    }
    return true;
  });
  if (freeSingles.length > 0) return freeSingles[0];

  if (!allowJoinedTables) return null;
  if (joinedTablesFallbackOnly && singles.length > 0) return null;

  const joined = buildJoinedCandidates({
    tables,
    joins,
    partySize,
    oversizeToleranceSeats,
    smokingPreference,
    includeAiOnly,
    maxJoinedTables
  }).sort(compareAssignmentCandidates);

  for (const candidate of joined) {
    if (candidateBlockedByManualState(candidate, tableById)) continue;
    if (
      candidateBlockedByReservations({
        candidate,
        reservations: relevantReservations,
        start,
        end,
        bufferMinutes
      })
    ) {
      continue;
    }
    return candidate;
  }

  return null;
}

/**
 * Saturation formula used for AI auto-booking gate:
 * compatibleTables = active tables that are AI-bookable and match smoking preference.
 * blockedTables = compatible tables currently blocked by manual state or overlapping reservations.
 * saturation% = round((blockedTables / compatibleTables) * 100).
 */
export function computeAutoBookingSaturationPercent(params: {
  tables: RestaurantAssignmentTable[];
  reservations: RestaurantReservationSlice[];
  smokingPreference: RestaurantSmokingPreference;
  start: DateTime;
  end: DateTime;
  bufferMinutes: number;
}): number {
  const { tables, reservations, smokingPreference, start, end, bufferMinutes } =
    params;
  const reservationBotId = tables[0]?.botId;
  const relevantReservations =
    reservationBotId != null
      ? reservations.filter((r) => r.botId === reservationBotId)
      : reservations;

  const compatible = tables.filter((table) => {
    if (!table.isActive) return false;
    if (!table.isAiBookable) return false;
    if (!tableMatchesSmokingPreference(table, smokingPreference)) return false;
    if (table.manualState === "OUT_OF_SERVICE") return false;
    return true;
  });
  if (compatible.length === 0) return 100;

  let blocked = 0;
  for (const table of compatible) {
    if (table.manualState === "RESERVED" || table.manualState === "OCCUPIED") {
      blocked += 1;
      continue;
    }
    const hasOverlap = relevantReservations.some((reservation) => {
      if (!BLOCKING_STATUSES.includes(reservation.status)) return false;
      if (!reservation.tableIds.includes(table.id)) return false;
      return reservationBlocksInterval({
        reservationStart: reservation.startAt,
        reservationEnd: reservation.endAt,
        reservationBufferMinutes: reservation.bufferMinutes,
        candidateStart: start,
        candidateEnd: end,
        candidateBufferMinutes: bufferMinutes
      });
    });
    if (hasOverlap) blocked += 1;
  }
  return Math.round((blocked / compatible.length) * 100);
}

export function isReservationExpiredByNoShow(params: {
  status: RestaurantReservationStatus;
  end: DateTime;
  now: DateTime;
}): boolean {
  if (params.status !== "PENDING" && params.status !== "CONFIRMED") {
    return false;
  }
  return params.end < params.now;
}

export function deriveTableStateAtMoment(params: {
  manualState: RestaurantTableManualState;
  reservations: Array<{
    status: RestaurantReservationStatus;
    start: DateTime;
    end: DateTime;
    bufferMinutes: number;
  }>;
  now: DateTime;
}): "free" | "reserved" | "occupied" | "out_of_service" {
  const { manualState, reservations, now } = params;
  if (manualState === "OUT_OF_SERVICE") return "out_of_service";
  if (manualState === "OCCUPIED") return "occupied";
  if (manualState === "RESERVED") return "reserved";
  if (manualState === "FREE") return "free";

  for (const reservation of reservations) {
    // Floor state should reflect the actual reservation window only.
    // Buffer is used for allocation/conflict checks, not for visual occupancy state.
    const active = reservation.start <= now && reservation.end > now;
    if (!active) continue;
    if (reservation.status === "CHECKED_IN") return "occupied";
    if (
      reservation.status === "PENDING" ||
      reservation.status === "CONFIRMED"
    ) {
      return "reserved";
    }
  }
  return "free";
}

async function loadBotBySlug(slug: string): Promise<any | null> {
  return db.bot.findUnique({
    where: { slug },
    include: { user: { select: { email: true } } }
  });
}

async function loadBotById(botId: string): Promise<any | null> {
  return db.bot.findUnique({
    where: { id: botId },
    include: { user: { select: { email: true } } }
  });
}

async function ensureRestaurantConfigForBot(bot: any): Promise<any> {
  const existing = await db.restaurantConfig.findUnique({
    where: { botId: bot.id }
  });
  if (existing) return existing;

  return db.restaurantConfig.create({
    data: {
      botId: bot.id,
      timeZone: bot.timeZone || "UTC",
      defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
      bufferMinutes: DEFAULT_BUFFER_MINUTES,
      autoBookingSaturationPct: DEFAULT_SATURATION_PCT,
      oversizeToleranceSeats: DEFAULT_OVERSIZE_TOLERANCE,
      allowJoinedTables: true,
      joinedTablesFallbackOnly: true,
      maxJoinedTables: DEFAULT_MAX_JOINED_TABLES,
      lateArrivalGraceMinutes: DEFAULT_LATE_ARRIVAL_GRACE_MINUTES,
      noShowAfterMinutes: DEFAULT_NO_SHOW_AFTER_MINUTES
    }
  });
}

function toReservationSlice(
  reservation: any,
  timeZone: string
): RestaurantReservationSlice {
  return {
    botId: reservation.botId,
    status: reservation.status as RestaurantReservationStatus,
    startAt: asDateTime(reservation.startAt, timeZone),
    endAt: asDateTime(reservation.endAt, timeZone),
    bufferMinutes:
      typeof reservation.bufferMinutes === "number"
        ? reservation.bufferMinutes
        : DEFAULT_BUFFER_MINUTES,
    tableIds: (reservation.tables || []).map((rt: any) => rt.tableId)
  };
}

async function expireStaleReservations(
  tx: any,
  botId: string,
  now: DateTime
): Promise<number> {
  const result = await tx.restaurantReservation.updateMany({
    where: {
      botId,
      status: { in: ["PENDING", "CONFIRMED"] },
      endAt: { lt: now.toJSDate() }
    },
    data: {
      status: "EXPIRED",
      expiredAt: now.toJSDate()
    }
  });
  if ((result?.count || 0) > 0) {
    await tx.$executeRaw`
      UPDATE "RestaurantReservationTable" AS rrt
      SET "isBlocking" = false
      FROM "RestaurantReservation" AS rr
      WHERE rr."id" = rrt."reservationId"
        AND rr."botId" = ${botId}
        AND rr."status" = 'EXPIRED'
        AND rrt."isBlocking" = true
    `;
  }
  return result?.count || 0;
}

async function recoverPrematurelyExpiredReservations(
  tx: any,
  botId: string,
  now: DateTime
): Promise<number> {
  // Recovery for reservations incorrectly expired by historical dashboard
  // time-travel reads. We only recover future/ongoing windows that were never
  // manually finalized/cancelled/no-showed.
  const result = await tx.restaurantReservation.updateMany({
    where: {
      botId,
      status: "EXPIRED",
      endAt: { gt: now.toJSDate() },
      checkedInAt: null,
      cancelledAt: null,
      noShowMarkedAt: null,
      completedAt: null
    },
    data: {
      status: "CONFIRMED",
      expiredAt: null
    }
  });
  if ((result?.count || 0) > 0) {
    await tx.$executeRaw`
      UPDATE "RestaurantReservationTable" AS rrt
      SET "isBlocking" = true
      FROM "RestaurantReservation" AS rr
      WHERE rr."id" = rrt."reservationId"
        AND rr."botId" = ${botId}
        AND rr."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND rr."endAt" > ${now.toJSDate()}
        AND rrt."isBlocking" = false
    `;
  }
  return result?.count || 0;
}

function buildCheckInToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

function frontendOrigin(): string {
  const raw = String(process.env.FRONTEND_ORIGIN || "").trim();
  if (!raw) return "http://localhost:5173";
  const first = raw
    .split(",")
    .map((v) => v.trim())
    .find(Boolean);
  return first || "http://localhost:5173";
}

function buildCheckInUrl(token: string): string {
  const base = frontendOrigin().replace(/\/+$/, "");
  return `${base}/app/restaurants/check-in/${encodeURIComponent(token)}`;
}

function buildQrImageUrl(url: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
    url
  )}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendReservationCreatedEmails(params: {
  bot: any;
  reservation: any;
  tableCodes: string[];
  checkInUrl: string;
}): Promise<{ customerSent: boolean; customerError?: string }> {
  const { bot, reservation, tableCodes, checkInUrl } = params;
  const qrImageUrl = buildQrImageUrl(checkInUrl);
  const start = DateTime.fromJSDate(reservation.startAt).setZone(
    reservation.timeZone || bot.timeZone || "UTC"
  );
  const end = DateTime.fromJSDate(reservation.endAt).setZone(
    reservation.timeZone || bot.timeZone || "UTC"
  );
  const when = start.toFormat("cccc, dd LLLL yyyy HH:mm");
  const endWhen = end.toFormat("cccc, dd LLLL yyyy HH:mm");
  const tablesText = tableCodes.join(", ");
  const serviceLabel = "Table reservation";
  const customerName = String(reservation.customerName || "");
  const customerEmail = String(reservation.customerEmail || "");
  const customerPhone = String(reservation.customerPhone || "");
  const timezone = String(reservation.timeZone || bot.timeZone || "UTC");
  const brandName = String(bot.name || "");
  const brandUrl = String(bot.domain || "");

  const contextText: Record<string, string> = {
    name: customerName,
    email: customerEmail,
    phone: customerPhone,
    service: serviceLabel,
    date: when,
    time: start.toFormat("HH:mm"),
    timezone,
    brandName,
    brandUrl,
    checkInUrl,
    tables: tablesText,
    table: tablesText,
    partySize: String(reservation.partySize ?? ""),
    qrCodeUrl: qrImageUrl,
    reason: "",
    "client.name": customerName,
    "client.email": customerEmail,
    "client.phone": customerPhone,
    "booking.start": when,
    "booking.end": endWhen,
    "booking.date": when,
    "booking.time": start.toFormat("HH:mm"),
    "booking.timezone": timezone,
    "booking.service": serviceLabel,
    "booking.tables": tablesText,
    "booking.table": tablesText,
    "booking.partySize": String(reservation.partySize ?? ""),
    "booking.checkInUrl": checkInUrl,
    "booking.qrCodeUrl": qrImageUrl,
    "booking.reason": "",
    "bot.name": brandName,
    "bot.url": brandUrl
  };

  const contextHtml: Record<string, string> = {
    name: escapeHtml(customerName),
    email: escapeHtml(customerEmail),
    phone: escapeHtml(customerPhone),
    service: escapeHtml(serviceLabel),
    date: escapeHtml(when),
    time: escapeHtml(start.toFormat("HH:mm")),
    timezone: escapeHtml(timezone),
    brandName: escapeHtml(brandName),
    brandUrl: escapeHtml(brandUrl),
    checkInUrl: escapeHtml(checkInUrl),
    tables: escapeHtml(tablesText),
    table: escapeHtml(tablesText),
    partySize: escapeHtml(String(reservation.partySize ?? "")),
    qrCodeUrl: escapeHtml(qrImageUrl),
    reason: "",
    "client.name": escapeHtml(customerName),
    "client.email": escapeHtml(customerEmail),
    "client.phone": escapeHtml(customerPhone),
    "booking.start": escapeHtml(when),
    "booking.end": escapeHtml(endWhen),
    "booking.date": escapeHtml(when),
    "booking.time": escapeHtml(start.toFormat("HH:mm")),
    "booking.timezone": escapeHtml(timezone),
    "booking.service": escapeHtml(serviceLabel),
    "booking.tables": escapeHtml(tablesText),
    "booking.table": escapeHtml(tablesText),
    "booking.partySize": escapeHtml(String(reservation.partySize ?? "")),
    "booking.checkInUrl": escapeHtml(checkInUrl),
    "booking.qrCodeUrl": escapeHtml(qrImageUrl),
    "booking.reason": "",
    "bot.name": escapeHtml(brandName),
    "bot.url": escapeHtml(brandUrl)
  };

  const defaultText =
    `Hi {{client.name}},\n\n` +
    `Your reservation at {{bot.name}} is confirmed.\n` +
    `When: {{booking.start}} ({{timezone}})\n` +
    `Party size: {{booking.partySize}}\n` +
    `Table(s): {{booking.tables}}\n\n` +
    `On arrival, please show your reservation QR code to the restaurant staff for check-in.\n\n` +
    `Thank you.`;

  const defaultHtml =
    `<p>Hi {{client.name}},</p>` +
    `<p>Your reservation at <strong>{{bot.name}}</strong> is confirmed.</p>` +
    `<p><strong>When:</strong> {{booking.start}} ({{timezone}})<br>` +
    `<strong>Party size:</strong> {{booking.partySize}}<br>` +
    `<strong>Table(s):</strong> {{booking.tables}}</p>` +
    `<p>Please show this QR code to restaurant staff on arrival for check-in.</p>` +
    `<p><img src="${escapeHtml(
      qrImageUrl
    )}" alt="Reservation check-in QR code" width="240" height="240" /></p>`;

  const ownerEmail = bot?.user?.email || null;
  if (ownerEmail) {
    await sendBotMail({
      botId: bot.id,
      kind: "restaurant_booking_owner_notification",
      to: ownerEmail,
      subject: `New reservation - ${bot.name}`,
      text:
        `Customer: ${reservation.customerName}\n` +
        `Email: ${reservation.customerEmail}\n` +
        `Phone: ${reservation.customerPhone}\n` +
        `When: ${when}\n` +
        `Party size: ${reservation.partySize}\n` +
        `Table(s): ${tablesText}\n` +
        `Source: ${reservation.source}`
      });
  }

  if (bot.bookingConfirmationEmailEnabled === false) {
    return {
      customerSent: false,
      customerError: "confirmation_email_disabled"
    };
  }

  const subjectTemplate =
    bot.bookingConfirmationSubjectTemplate ||
    "Your reservation at {{bot.name}}";
  const textTemplate = bot.bookingConfirmationBodyTextTemplate || defaultText;
  const htmlTemplate = bot.bookingConfirmationBodyHtmlTemplate || defaultHtml;

  const subject = renderTemplate(subjectTemplate, contextText);
  const text = renderTemplate(textTemplate, contextText);
  const html = renderTemplate(htmlTemplate, contextHtml);

  const customerSend = await sendBotMail({
    botId: bot.id,
    kind: "restaurant_booking_confirmation",
    to: reservation.customerEmail,
    subject,
    text,
    html
  });

  return {
    customerSent: customerSend.sent,
    customerError: customerSend.sent ? undefined : customerSend.reason
  };
}

async function sendReservationCancelledEmails(params: {
  bot: any;
  reservation: any;
  reason?: string;
}): Promise<void> {
  const { bot, reservation, reason } = params;
  const start = DateTime.fromJSDate(reservation.startAt).setZone(
    reservation.timeZone || bot.timeZone || "UTC"
  );
  const when = start.toFormat("cccc, dd LLLL yyyy HH:mm");
  const serviceLabel = "Table reservation";
  const customerName = String(reservation.customerName || "");
  const customerEmail = String(reservation.customerEmail || "");
  const customerPhone = String(reservation.customerPhone || "");
  const timezone = String(reservation.timeZone || bot.timeZone || "UTC");
  const reasonText = reason || "not specified";
  const brandName = String(bot.name || "");
  const brandUrl = String(bot.domain || "");
  const endWhen = DateTime.fromJSDate(reservation.endAt)
    .setZone(reservation.timeZone || bot.timeZone || "UTC")
    .toFormat("cccc, dd LLLL yyyy HH:mm");

  const contextText: Record<string, string> = {
    name: customerName,
    email: customerEmail,
    phone: customerPhone,
    service: serviceLabel,
    date: when,
    time: start.toFormat("HH:mm"),
    timezone,
    brandName,
    brandUrl,
    reason: reasonText,
    checkInUrl: "",
    tables: "",
    table: "",
    partySize: String(reservation.partySize ?? ""),
    qrCodeUrl: "",
    "client.name": customerName,
    "client.email": customerEmail,
    "client.phone": customerPhone,
    "booking.start": when,
    "booking.end": endWhen,
    "booking.date": when,
    "booking.time": start.toFormat("HH:mm"),
    "booking.timezone": timezone,
    "booking.service": serviceLabel,
    "booking.tables": "",
    "booking.table": "",
    "booking.partySize": String(reservation.partySize ?? ""),
    "booking.checkInUrl": "",
    "booking.qrCodeUrl": "",
    "booking.reason": reasonText,
    "bot.name": brandName,
    "bot.url": brandUrl
  };

  const contextHtml: Record<string, string> = {
    name: escapeHtml(customerName),
    email: escapeHtml(customerEmail),
    phone: escapeHtml(customerPhone),
    service: escapeHtml(serviceLabel),
    date: escapeHtml(when),
    time: escapeHtml(start.toFormat("HH:mm")),
    timezone: escapeHtml(timezone),
    brandName: escapeHtml(brandName),
    brandUrl: escapeHtml(brandUrl),
    reason: escapeHtml(reasonText),
    checkInUrl: "",
    tables: "",
    table: "",
    partySize: escapeHtml(String(reservation.partySize ?? "")),
    qrCodeUrl: "",
    "client.name": escapeHtml(customerName),
    "client.email": escapeHtml(customerEmail),
    "client.phone": escapeHtml(customerPhone),
    "booking.start": escapeHtml(when),
    "booking.end": escapeHtml(endWhen),
    "booking.date": escapeHtml(when),
    "booking.time": escapeHtml(start.toFormat("HH:mm")),
    "booking.timezone": escapeHtml(timezone),
    "booking.service": escapeHtml(serviceLabel),
    "booking.tables": "",
    "booking.table": "",
    "booking.partySize": escapeHtml(String(reservation.partySize ?? "")),
    "booking.checkInUrl": "",
    "booking.qrCodeUrl": "",
    "booking.reason": escapeHtml(reasonText),
    "bot.name": escapeHtml(brandName),
    "bot.url": escapeHtml(brandUrl)
  };

  const subjectTemplate =
    bot.bookingCancellationSubjectTemplate ||
    "Reservation cancelled - {{bot.name}}";
  const defaultText =
    `Hi {{client.name}},\n\n` +
    `Your reservation at {{bot.name}} has been cancelled.\n` +
    `When: {{booking.start}}\n` +
    `Reason: {{reason}}\n`;
  const defaultHtml =
    `<p>Hi {{client.name}},</p>` +
    `<p>Your reservation at <strong>{{bot.name}}</strong> has been cancelled.</p>` +
    `<p><strong>When:</strong> {{booking.start}}<br>` +
    `<strong>Reason:</strong> {{reason}}</p>`;
  const textTemplate = bot.bookingCancellationBodyTextTemplate || defaultText;
  const htmlTemplate = bot.bookingCancellationBodyHtmlTemplate || defaultHtml;

  const subject = renderTemplate(subjectTemplate, contextText);
  const text = renderTemplate(textTemplate, contextText);
  const html = renderTemplate(htmlTemplate, contextHtml);

  await sendBotMail({
    botId: bot.id,
    kind: "restaurant_booking_cancellation",
    to: reservation.customerEmail,
    subject,
    text,
    html
  });
}

function renderTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey || "").trim();
    const value = context[key] ?? "";
    return value;
  });
}

function normalizeRulesInput(input: RestaurantRulesInput | undefined): any {
  if (!input) return {};
  const out: any = {};
  if (typeof input.timeZone === "string") out.timeZone = input.timeZone.trim();
  if (Array.isArray(input.closedDates)) {
    out.closedDates = input.closedDates
      .map((v) => String(v || "").trim())
      .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
  }
  if (input.openingHours && typeof input.openingHours === "object") {
    out.openingHours = input.openingHours;
  }
  const numericFields: Array<keyof RestaurantRulesInput> = [
    "defaultDurationMinutes",
    "bufferMinutes",
    "autoBookingSaturationPct",
    "oversizeToleranceSeats",
    "maxJoinedTables",
    "lateArrivalGraceMinutes",
    "noShowAfterMinutes"
  ];
  for (const field of numericFields) {
    const value = input[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[field] = Math.floor(value);
    }
  }
  if (typeof input.allowJoinedTables === "boolean") {
    out.allowJoinedTables = input.allowJoinedTables;
  }
  if (typeof input.joinedTablesFallbackOnly === "boolean") {
    out.joinedTablesFallbackOnly = input.joinedTablesFallbackOnly;
  }
  return out;
}

export async function getRestaurantSetup(botId: string): Promise<any> {
  const bot = await loadBotById(botId);
  if (!bot) return null;
  const config = await ensureRestaurantConfigForBot(bot);
  const [rooms, joins] = await Promise.all([
    db.restaurantRoom.findMany({
      where: { botId },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      include: {
        tables: {
          orderBy: [{ code: "asc" }]
        }
      }
    }),
    db.restaurantTableJoin.findMany({
      where: { botId },
      orderBy: [{ createdAt: "asc" }],
      include: { members: true }
    })
  ]);

  return {
    botId,
    bookingSystemType: bot.bookingSystemType || "GENERIC",
    rules: config,
    rooms: rooms.map((room: any) => ({
      id: room.id,
      name: room.name,
      notes: room.notes,
      displayOrder: room.displayOrder,
      isActive: room.isActive,
      tables: room.tables.map((table: any) => ({
        id: table.id,
        roomId: table.roomId,
        code: table.code,
        capacity: table.capacity,
        isSmoking: table.isSmoking,
        notes: table.notes,
        isAiBookable: table.isAiBookable,
        isActive: table.isActive,
        manualState: table.manualState,
        manualStateNote: table.manualStateNote
      }))
    })),
    joins: joins.map((join: any) => ({
      id: join.id,
      name: join.name,
      isActive: join.isActive,
      allowAiBooking: join.allowAiBooking,
      tableIds: join.members.map((m: any) => m.tableId)
    }))
  };
}

export async function saveRestaurantSetup(params: {
  botId: string;
  input: RestaurantSetupInput;
  actorUserId: string;
}): Promise<any> {
  const { botId, input, actorUserId } = params;
  const bot = await loadBotById(botId);
  if (!bot) throw new Error("Bot not found");

  const roomsInput = Array.isArray(input.rooms) ? input.rooms : [];
  const joinsInput = Array.isArray(input.joins) ? input.joins : [];
  const rulesInput = normalizeRulesInput(input.rules);
  assertUniqueRestaurantTableCodesPerRoom(roomsInput);

  await db.$transaction(async (tx: any) => {
    await tx.bot.update({
      where: { id: botId },
      data: { bookingSystemType: "RESTAURANT" }
    });

    await tx.restaurantConfig.upsert({
      where: { botId },
      create: {
        botId,
        timeZone: rulesInput.timeZone || bot.timeZone || "UTC",
        ...rulesInput
      },
      update: rulesInput
    });

    const existingRooms = await tx.restaurantRoom.findMany({
      where: { botId },
      include: { tables: true }
    });
    const roomById = new Map<string, any>(existingRooms.map((r: any) => [r.id, r]));
    const keepRoomIds = new Set<string>();
    const keepTableIds = new Set<string>();

    for (let i = 0; i < roomsInput.length; i += 1) {
      const room = roomsInput[i];
      const roomName = String(room.name || "").trim();
      if (!roomName) continue;

      let roomId: string;
      if (room.id && roomById.has(room.id)) {
        roomId = room.id;
        await tx.restaurantRoom.update({
          where: { id: roomId },
          data: {
            name: roomName,
            notes: room.notes || null,
            displayOrder:
              typeof room.displayOrder === "number" ? room.displayOrder : i,
            isActive: room.isActive !== false
          }
        });
      } else {
        const created = await tx.restaurantRoom.create({
          data: {
            botId,
            name: roomName,
            notes: room.notes || null,
            displayOrder:
              typeof room.displayOrder === "number" ? room.displayOrder : i,
            isActive: room.isActive !== false
          }
        });
        roomId = created.id;
      }
      keepRoomIds.add(roomId);

      const existingTables = await tx.restaurantTable.findMany({
        where: { botId, roomId }
      });
      const tableById = new Map<string, any>(
        existingTables.map((t: any) => [t.id, t])
      );

      for (const table of room.tables || []) {
        const code = String(table.code || "").trim();
        if (!code) continue;
        const capacity = Number(table.capacity);
        if (!Number.isFinite(capacity) || capacity <= 0) continue;

        if (table.id && tableById.has(table.id)) {
          keepTableIds.add(table.id);
          await tx.restaurantTable.update({
            where: { id: table.id },
            data: {
              roomId,
              code,
              capacity: Math.floor(capacity),
              isSmoking: table.isSmoking === true,
              notes: table.notes || null,
              isAiBookable: table.isAiBookable !== false,
              isActive: table.isActive !== false
            }
          });
        } else {
          const created = await tx.restaurantTable.create({
            data: {
              botId,
              roomId,
              code,
              capacity: Math.floor(capacity),
              isSmoking: table.isSmoking === true,
              notes: table.notes || null,
              isAiBookable: table.isAiBookable !== false,
              isActive: table.isActive !== false
            }
          });
          keepTableIds.add(created.id);
        }
      }
    }

    for (const existingRoom of existingRooms) {
      if (!keepRoomIds.has(existingRoom.id)) {
        await tx.restaurantRoom.update({
          where: { id: existingRoom.id },
          data: { isActive: false }
        });
      }
      for (const table of existingRoom.tables) {
        if (!keepTableIds.has(table.id)) {
          await tx.restaurantTable.update({
            where: { id: table.id },
            data: { isActive: false }
          });
        }
      }
    }

    const existingJoins = await tx.restaurantTableJoin.findMany({
      where: { botId },
      include: { members: true }
    });
    const joinById = new Map<string, any>(
      existingJoins.map((j: any) => [j.id, j])
    );
    const keepJoinIds = new Set<string>();

    for (const join of joinsInput) {
      const name = String(join.name || "").trim();
      const tableIds = Array.from(
        new Set((join.tableIds || []).map((id) => String(id || "").trim()).filter(Boolean))
      );
      if (!name || tableIds.length < 2) continue;

      let joinId: string;
      if (join.id && joinById.has(join.id)) {
        joinId = join.id;
        await tx.restaurantTableJoin.update({
          where: { id: joinId },
          data: {
            name,
            isActive: join.isActive !== false,
            allowAiBooking: join.allowAiBooking !== false
          }
        });
      } else {
        const created = await tx.restaurantTableJoin.create({
          data: {
            botId,
            name,
            isActive: join.isActive !== false,
            allowAiBooking: join.allowAiBooking !== false
          }
        });
        joinId = created.id;
      }
      keepJoinIds.add(joinId);

      await tx.restaurantTableJoinMember.deleteMany({
        where: { joinId }
      });
      await tx.restaurantTableJoinMember.createMany({
        data: tableIds.map((tableId) => ({
          joinId,
          tableId
        })),
        skipDuplicates: true
      });
    }

    for (const existingJoin of existingJoins) {
      if (!keepJoinIds.has(existingJoin.id)) {
        await tx.restaurantTableJoin.update({
          where: { id: existingJoin.id },
          data: { isActive: false }
        });
      }
    }

    await tx.restaurantAuditLog.create({
      data: {
        botId,
        action: "restaurant.setup.updated",
        actor: "STAFF",
        actorUserId,
        details: {
          roomsCount: roomsInput.length,
          joinsCount: joinsInput.length
        }
      }
    });
  });

  return getRestaurantSetup(botId);
}

async function buildBookingContextForBot(bot: any, tx: any): Promise<{
  rules: RestaurantRulesResolved;
  tables: RestaurantAssignmentTable[];
  joins: RestaurantJoinOption[];
}> {
  const config = await tx.restaurantConfig.findUnique({
    where: { botId: bot.id }
  });
  const rules = resolveRules(config, bot.timeZone || "UTC");

  const tablesRaw = await tx.restaurantTable.findMany({
    where: { botId: bot.id }
  });
  const tables: RestaurantAssignmentTable[] = tablesRaw.map((t: any) => ({
    id: t.id,
    botId: t.botId,
    roomId: t.roomId,
    code: t.code,
    capacity: t.capacity,
    isSmoking: t.isSmoking,
    isAiBookable: t.isAiBookable,
    isActive: t.isActive,
    manualState: t.manualState
  }));

  const joinsRaw = await tx.restaurantTableJoin.findMany({
    where: { botId: bot.id },
    include: { members: true }
  });
  const joins: RestaurantJoinOption[] = joinsRaw.map((join: any) => ({
    id: join.id,
    name: join.name,
    isActive: join.isActive,
    allowAiBooking: join.allowAiBooking,
    tableIds: (join.members || []).map((m: any) => m.tableId)
  }));

  return { rules, tables, joins };
}

async function createRestaurantReservationInternal(params: {
  bot: any;
  source: RestaurantReservationSource;
  actor: RestaurantReservationActor;
  actorUserId?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  partySize: number;
  datetimeIso: string;
  smokingPreference: RestaurantSmokingPreference;
  notes?: string;
  allowAiGate: boolean;
  forceTableIds?: string[] | null;
}): Promise<RestaurantChatResult> {
  const {
    bot,
    source,
    actor,
    actorUserId,
    customerName,
    customerEmail,
    customerPhone,
    partySize,
    datetimeIso,
    smokingPreference,
    notes,
    allowAiGate,
    forceTableIds
  } = params;

  if (!isValidEmail(customerEmail)) {
    return {
      success: false,
      errorCode: "invalid_email",
      errorMessage: "Invalid email address."
    };
  }
  if (!Number.isFinite(partySize) || partySize <= 0) {
    return {
      success: false,
      errorCode: "invalid_party_size",
      errorMessage: "Party size must be a positive number."
    };
  }

  try {
    return await db.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT "id" FROM "RestaurantTable" WHERE "botId" = ${bot.id} FOR UPDATE`;

      const { rules, tables, joins } = await buildBookingContextForBot(bot, tx);
      const start = DateTime.fromISO(datetimeIso, { zone: rules.timeZone });
      if (!start.isValid) {
        return {
          success: false,
          errorCode: "invalid_datetime",
          errorMessage: "Invalid reservation date/time."
        };
      }
      const end = start.plus({ minutes: rules.defaultDurationMinutes });
      const now = DateTime.now().setZone(rules.timeZone);
      if (start < now) {
        return {
          success: false,
          errorCode: "time_in_past",
          errorMessage: "The requested time is in the past."
        };
      }

      const minLeadHours =
        typeof bot.bookingMinLeadHours === "number" &&
        Number.isFinite(bot.bookingMinLeadHours) &&
        bot.bookingMinLeadHours > 0
          ? Math.floor(bot.bookingMinLeadHours)
          : null;
      if (minLeadHours !== null) {
        const minAllowed = now.plus({ hours: minLeadHours });
        if (start < minAllowed) {
          return {
            success: false,
            errorCode: "min_lead_hours",
            errorMessage: `Bookings must be made at least ${minLeadHours} hour(s) in advance.`
          };
        }
      }

      const maxAdvanceDays =
        typeof bot.bookingMaxAdvanceDays === "number" &&
        Number.isFinite(bot.bookingMaxAdvanceDays) &&
        bot.bookingMaxAdvanceDays > 0
          ? Math.floor(bot.bookingMaxAdvanceDays)
          : null;
      if (maxAdvanceDays !== null) {
        const maxAllowed = now.plus({ days: maxAdvanceDays });
        if (start > maxAllowed) {
          return {
            success: false,
            errorCode: "max_advance_days",
            errorMessage: `Bookings cannot be made more than ${maxAdvanceDays} day(s) in advance.`
          };
        }
      }

      const isOpen = isReservationWithinOpeningHours({
        start,
        end,
        openingHours: rules.openingHours,
        closedDates: rules.closedDates
      });
      if (!isOpen) {
        return {
          success: false,
          errorCode: "outside_opening_hours",
          errorMessage:
            "The requested date/time is outside restaurant opening hours."
        };
      }

      await recoverPrematurelyExpiredReservations(tx, bot.id, now);
      await expireStaleReservations(tx, bot.id, now);

      const reservationsRaw = await tx.restaurantReservation.findMany({
        where: {
          botId: bot.id,
          status: { in: BLOCKING_STATUSES },
          startAt: { lt: end.plus({ hours: 8 }).toJSDate() },
          endAt: { gt: start.minus({ hours: 8 }).toJSDate() }
        },
        include: { tables: true }
      });
      const reservations: RestaurantReservationSlice[] = reservationsRaw.map((r: any) =>
        toReservationSlice(r, rules.timeZone)
      );

      const saturationPercent = computeAutoBookingSaturationPercent({
        tables,
        reservations,
        smokingPreference,
        start,
        end,
        bufferMinutes: rules.bufferMinutes
      });

      if (allowAiGate && saturationPercent > rules.autoBookingSaturationPct) {
        return {
          success: false,
          errorCode: "auto_booking_threshold_exceeded",
          errorMessage:
            "Automatic confirmation is currently limited. Please contact the restaurant directly.",
          thresholdTriggered: true,
          saturationPercent
        };
      }

      let assignment: RestaurantAssignmentCandidate | null = null;
      if (forceTableIds && forceTableIds.length > 0) {
        const uniqueTableIds = Array.from(
          new Set(forceTableIds.map((id) => String(id || "").trim()).filter(Boolean))
        );
        const tableById = new Map<string, RestaurantAssignmentTable>(
          tables.map((t) => [t.id, t])
        );
        const assignedTables = uniqueTableIds
          .map((id) => tableById.get(id))
          .filter(Boolean) as RestaurantAssignmentTable[];
        if (assignedTables.length !== uniqueTableIds.length) {
          return {
            success: false,
            errorCode: "table_not_found",
            errorMessage: "One or more selected tables were not found."
          };
        }
        const totalCapacity = assignedTables.reduce((sum, t) => sum + t.capacity, 0);
        if (totalCapacity < partySize) {
          return {
            success: false,
            errorCode: "table_capacity_insufficient",
            errorMessage: "Selected table capacity is lower than party size."
          };
        }
        assignment = {
          tableIds: assignedTables.map((t) => t.id).sort(),
          tableCodes: assignedTables
            .map((t) => t.code)
            .sort((a, b) => a.localeCompare(b, "en")),
          totalCapacity,
          wastedSeats: totalCapacity - partySize,
          maxTableCapacity: assignedTables.reduce((m, t) => Math.max(m, t.capacity), 0),
          joined: assignedTables.length > 1,
          exactFit: totalCapacity === partySize
        };
      } else {
        assignment = chooseBestRestaurantAssignment({
          tables,
          joins: joins.filter((join) => join.allowAiBooking || !allowAiGate),
          reservations,
          partySize,
          smokingPreference,
          oversizeToleranceSeats: rules.oversizeToleranceSeats,
          allowJoinedTables: rules.allowJoinedTables,
          joinedTablesFallbackOnly: rules.joinedTablesFallbackOnly,
          maxJoinedTables: rules.maxJoinedTables,
          start,
          end,
          bufferMinutes: rules.bufferMinutes,
          includeAiOnly: allowAiGate
        });
      }

      if (!assignment) {
        return {
          success: false,
          errorCode: "no_table_available",
          errorMessage:
            "No compatible table is currently available for that date/time and party size."
        };
      }
      const { token, tokenHash } = buildCheckInToken();
      const created = await tx.restaurantReservation.create({
        data: {
          botId: bot.id,
          source,
          status: "CONFIRMED",
          customerName,
          customerEmail,
          customerPhone,
          partySize,
          smokingPreference,
          notes: notes || null,
          startAt: start.toJSDate(),
          endAt: end.toJSDate(),
          durationMinutes: rules.defaultDurationMinutes,
          bufferMinutes: rules.bufferMinutes,
          aiAutoApproved: allowAiGate,
          saturationPercentAtBooking: saturationPercent,
          checkInTokenHash: tokenHash,
          checkInTokenIssuedAt: now.toJSDate(),
          createdByUserId: actorUserId || null
        }
      });

      const { blockedFrom, blockedUntil } = computeReservationAllocationWindow({
        startAt: created.startAt,
        endAt: created.endAt,
        bufferMinutes: created.bufferMinutes
      });
      await tx.restaurantReservationTable.createMany({
        data: assignment.tableIds.map((tableId, idx) => ({
          reservationId: created.id,
          tableId,
          blockedFrom,
          blockedUntil,
          isBlocking: true,
          role: idx === 0 ? "PRIMARY" : "JOINED"
        }))
      });

      await tx.restaurantAuditLog.create({
        data: {
          botId: bot.id,
          reservationId: created.id,
          action: "reservation.created",
          actor,
          actorUserId: actorUserId || null,
          details: {
            source,
            assignedTableIds: assignment.tableIds,
            assignedTableCodes: assignment.tableCodes,
            saturationPercent
          }
        }
      });

      const checkInUrl = buildCheckInUrl(token);
      const emailResult = await sendReservationCreatedEmails({
        bot,
        reservation: {
          ...created,
          timeZone: rules.timeZone
        },
        tableCodes: assignment.tableCodes,
        checkInUrl
      });

      return {
        success: true,
        action: "created",
        reservationId: created.id,
        start: start.toISO() || undefined,
        end: end.toISO() || undefined,
        partySize,
        assignedTables: assignment.tableCodes,
        checkInUrl,
        confirmationEmailSent: emailResult.customerSent,
        confirmationEmailError: emailResult.customerError
      };
    });
  } catch (error) {
    if (isRestaurantAllocationOverlapDbError(error)) {
      return {
        success: false,
        errorCode: "no_table_available",
        errorMessage:
          "The selected table was just allocated to another reservation. Please choose another time."
      };
    }
    throw error;
  }
}

export async function handleRestaurantCreateFromChat(
  slug: string,
  args: RestaurantChatCreateArgs
): Promise<RestaurantChatResult> {
  const bot = await loadBotBySlug(slug);
  if (!bot) {
    return {
      success: false,
      errorCode: "bot_not_found",
      errorMessage: "Bot not found."
    };
  }
  if (bot.bookingSystemType !== "RESTAURANT") {
    return {
      success: false,
      errorCode: "restaurant_booking_disabled",
      errorMessage: "Restaurant booking is not enabled for this bot."
    };
  }

  return createRestaurantReservationInternal({
    bot,
    source: "AI",
    actor: "AI",
    customerName: String(args.name || "").trim(),
    customerEmail: normalizeEmail(String(args.email || "")),
    customerPhone: String(args.phone || "").trim(),
    partySize: Math.floor(Number(args.partySize || 0)),
    datetimeIso: String(args.datetime || "").trim(),
    smokingPreference: normalizeSmokingPreference(args.smokingPreference),
    notes: args.notes?.trim(),
    allowAiGate: true
  });
}

export async function handleRestaurantCancelFromChat(
  slug: string,
  args: RestaurantChatCancelArgs
): Promise<RestaurantChatResult> {
  const bot = await loadBotBySlug(slug);
  if (!bot) {
    return {
      success: false,
      errorCode: "bot_not_found",
      errorMessage: "Bot not found."
    };
  }
  if (bot.bookingSystemType !== "RESTAURANT") {
    return {
      success: false,
      errorCode: "restaurant_booking_disabled",
      errorMessage: "Restaurant booking is not enabled for this bot."
    };
  }

  const config = await ensureRestaurantConfigForBot(bot);
  const rules = resolveRules(config, bot.timeZone || "UTC");
  const requestedStart = DateTime.fromISO(String(args.datetime || "").trim(), {
    zone: rules.timeZone
  });
  if (!requestedStart.isValid) {
    return {
      success: false,
      errorCode: "invalid_datetime",
      errorMessage: "Invalid reservation date/time."
    };
  }

  const existing = await db.restaurantReservation.findFirst({
    where: {
      botId: bot.id,
      customerEmail: normalizeEmail(String(args.email || "")),
      status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN"] },
      startAt: {
        gte: requestedStart.minus({ minutes: 45 }).toJSDate(),
        lte: requestedStart.plus({ minutes: 45 }).toJSDate()
      }
    }
  });

  if (!existing) {
    return {
      success: false,
      errorCode: "reservation_not_found",
      errorMessage: "No reservation found with that email and date/time."
    };
  }

  const cancelled = await cancelRestaurantReservation({
    botId: bot.id,
    reservationId: existing.id,
    actor: "CUSTOMER",
    actorUserId: null,
    reason: args.reason || "Cancelled by customer chat request"
  });

  return {
    success: cancelled.success,
    action: cancelled.success ? "cancelled" : undefined,
    errorCode: cancelled.errorCode,
    errorMessage: cancelled.errorMessage,
    reservationId: existing.id
  };
}

export async function getRestaurantChatContext(botId: string): Promise<{
  enabled: boolean;
  timeZone: string;
  shouldAskSmokingPreference: boolean;
}> {
  const bot = await loadBotById(botId);
  if (!bot || bot.bookingSystemType !== "RESTAURANT") {
    return {
      enabled: false,
      timeZone: bot?.timeZone || "UTC",
      shouldAskSmokingPreference: false
    };
  }

  const config = await ensureRestaurantConfigForBot(bot);
  const rules = resolveRules(config, bot.timeZone || "UTC");
  const stats = await db.restaurantTable.groupBy({
    by: ["isSmoking"],
    where: {
      botId,
      isActive: true,
      isAiBookable: true
    },
    _count: { _all: true }
  });
  const hasSmoking = stats.some((s: any) => s.isSmoking && s._count._all > 0);
  const hasNonSmoking = stats.some(
    (s: any) => !s.isSmoking && s._count._all > 0
  );

  return {
    enabled: true,
    timeZone: rules.timeZone,
    shouldAskSmokingPreference: hasSmoking && hasNonSmoking
  };
}

export async function listRestaurantReservations(params: {
  botId: string;
  date?: string;
  q?: string;
  status?: string;
  limit?: number;
}): Promise<any[]> {
  const { botId, date, q, status } = params;
  const limit =
    typeof params.limit === "number" && params.limit > 0
      ? Math.min(params.limit, 200)
      : 100;

  const where: any = { botId };
  if (status) where.status = status;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const dayStart = DateTime.fromISO(`${date}T00:00:00`, { zone: "UTC" });
    where.startAt = {
      gte: dayStart.toJSDate(),
      lt: dayStart.plus({ days: 1 }).toJSDate()
    };
  }
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { customerName: { contains: term, mode: "insensitive" } },
      { customerEmail: { contains: term, mode: "insensitive" } },
      { customerPhone: { contains: term, mode: "insensitive" } }
    ];
  }

  const rows = await db.restaurantReservation.findMany({
    where,
    orderBy: [{ startAt: "asc" }],
    take: limit,
    include: {
      tables: {
        include: {
          table: {
            include: { room: true }
          }
        }
      }
    }
  });

  return rows.map((row: any) => ({
    id: row.id,
    source: row.source,
    status: row.status,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    partySize: row.partySize,
    smokingPreference: row.smokingPreference,
    notes: row.notes,
    startAt: row.startAt,
    endAt: row.endAt,
    tables: row.tables.map((rt: any) => ({
      id: rt.table.id,
      code: rt.table.code,
      roomName: rt.table.room?.name || null,
      role: rt.role
    }))
  }));
}

export async function getRestaurantDashboard(params: {
  botId: string;
  atIso?: string;
}): Promise<any> {
  const { botId, atIso } = params;
  const bot = await loadBotById(botId);
  if (!bot) throw new Error("Bot not found");
  const config = await ensureRestaurantConfigForBot(bot);
  const rules = resolveRules(config, bot.timeZone || "UTC");
  const operationalNow = DateTime.now().setZone(rules.timeZone);
  const selectedNow = atIso
    ? DateTime.fromISO(atIso, { zone: rules.timeZone })
    : operationalNow;
  const now = selectedNow.isValid ? selectedNow : operationalNow;

  await db.$transaction(async (tx: any) => {
    await recoverPrematurelyExpiredReservations(tx, botId, operationalNow);
    await expireStaleReservations(tx, botId, operationalNow);
  });

  const [rooms, reservations] = await Promise.all([
    db.restaurantRoom.findMany({
      where: { botId, isActive: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      include: { tables: { orderBy: [{ code: "asc" }] } }
    }),
    db.restaurantReservation.findMany({
      where: {
        botId,
        status: { in: BLOCKING_STATUSES.concat(["COMPLETED"] as any) },
        startAt: { lt: now.plus({ hours: 8 }).toJSDate() },
        endAt: { gt: now.minus({ hours: 8 }).toJSDate() }
      },
      orderBy: [{ startAt: "asc" }],
      include: {
        tables: {
          include: { table: true }
        }
      }
    })
  ]);

  const tableCurrent = new Map<
    string,
    { state: string; reservation: any | null; nextReservation: any | null }
  >();
  for (const room of rooms) {
    for (const table of room.tables) {
      tableCurrent.set(table.id, {
        state: "free",
        reservation: null,
        nextReservation: null
      });
    }
  }

  for (const reservation of reservations) {
    const start = asDateTime(reservation.startAt, rules.timeZone);
    const end = asDateTime(reservation.endAt, rules.timeZone);
    for (const rt of reservation.tables || []) {
      const tableState = tableCurrent.get(rt.tableId);
      if (!tableState) continue;
      if (
        reservation.status === "CHECKED_IN" &&
        start <= now &&
        end > now
      ) {
        tableState.state = "occupied";
        tableState.reservation = reservation;
      } else if (
        BLOCKING_STATUSES.includes(reservation.status) &&
        start <= now &&
        end > now
      ) {
        if (tableState.state !== "occupied") {
          tableState.state = "reserved";
          tableState.reservation = reservation;
        }
      } else if (start > now && !tableState.nextReservation) {
        tableState.nextReservation = reservation;
      }
    }
  }

  return {
    at: now.toISO(),
    timeZone: rules.timeZone,
    rooms: rooms.map((room: any) => ({
      id: room.id,
      name: room.name,
      tables: room.tables.map((table: any) => {
        const state = tableCurrent.get(table.id);
        let computedState = state?.state || "free";
        if (table.manualState === "OUT_OF_SERVICE") computedState = "out_of_service";
        if (table.manualState === "RESERVED") computedState = "reserved";
        if (table.manualState === "OCCUPIED") computedState = "occupied";
        if (table.manualState === "FREE") computedState = "free";
        return {
          id: table.id,
          code: table.code,
          capacity: table.capacity,
          isSmoking: table.isSmoking,
          isAiBookable: table.isAiBookable,
          isActive: table.isActive,
          manualState: table.manualState,
          manualStateNote: table.manualStateNote,
          state: computedState,
          currentReservation: state?.reservation
            ? {
                id: state.reservation.id,
                customerName: state.reservation.customerName,
                partySize: state.reservation.partySize,
                status: state.reservation.status,
                startAt: state.reservation.startAt,
                endAt: state.reservation.endAt,
                tableIds: state.reservation.tables.map((x: any) => x.tableId)
              }
            : null,
          nextReservation: state?.nextReservation
            ? {
                id: state.nextReservation.id,
                customerName: state.nextReservation.customerName,
                partySize: state.nextReservation.partySize,
                status: state.nextReservation.status,
                startAt: state.nextReservation.startAt,
                endAt: state.nextReservation.endAt,
                tableIds: state.nextReservation.tables.map((x: any) => x.tableId)
              }
            : null
        };
      })
    }))
  };
}

export async function createManualRestaurantReservation(params: {
  botId: string;
  actorUserId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  partySize: number;
  datetime: string;
  smokingPreference?: RestaurantSmokingPreference;
  notes?: string;
  tableIds?: string[];
}): Promise<RestaurantChatResult> {
  const bot = await loadBotById(params.botId);
  if (!bot) {
    return {
      success: false,
      errorCode: "bot_not_found",
      errorMessage: "Bot not found."
    };
  }

  return createRestaurantReservationInternal({
    bot,
    source: "STAFF",
    actor: "STAFF",
    actorUserId: params.actorUserId,
    customerName: params.customerName.trim(),
    customerEmail: normalizeEmail(params.customerEmail),
    customerPhone: params.customerPhone.trim(),
    partySize: Math.floor(params.partySize),
    datetimeIso: params.datetime,
    smokingPreference: params.smokingPreference || "NO_PREFERENCE",
    notes: params.notes?.trim(),
    allowAiGate: false,
    forceTableIds: params.tableIds
  });
}

export async function cancelRestaurantReservation(params: {
  botId: string;
  reservationId: string;
  actor: RestaurantReservationActor;
  actorUserId: string | null;
  reason?: string;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  const { botId, reservationId, actor, actorUserId, reason } = params;
  const reservation = await db.restaurantReservation.findFirst({
    where: { id: reservationId, botId }
  });
  if (!reservation) {
    return {
      success: false,
      errorCode: "reservation_not_found",
      errorMessage: "Reservation not found."
    };
  }
  if (reservation.status === "CANCELLED") return { success: true };
  const nextIsBlocking = false;

  await db.$transaction(async (tx: any) => {
    const { blockedFrom, blockedUntil } = computeReservationAllocationWindow({
      startAt: reservation.startAt,
      endAt: reservation.endAt,
      bufferMinutes: reservation.bufferMinutes
    });
    await tx.restaurantReservation.update({
      where: { id: reservationId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: actor
      }
    });
    await tx.restaurantReservationTable.updateMany({
      where: { reservationId },
      data: {
        blockedFrom,
        blockedUntil,
        isBlocking: nextIsBlocking
      }
    });
    await tx.restaurantAuditLog.create({
      data: {
        botId,
        reservationId,
        action: "reservation.cancelled",
        actor,
        actorUserId,
        details: { reason: reason || null }
      }
    });
  });

  const bot = await loadBotById(botId);
  if (bot) {
    await sendReservationCancelledEmails({
      bot,
      reservation,
      reason
    });
  }

  return { success: true };
}

async function updateReservationStatus(params: {
  botId: string;
  reservationId: string;
  allowedCurrent: RestaurantReservationStatus[];
  nextStatus: RestaurantReservationStatus;
  action: string;
  actor: RestaurantReservationActor;
  actorUserId: string | null;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  const {
    botId,
    reservationId,
    allowedCurrent,
    nextStatus,
    action,
    actor,
    actorUserId
  } = params;
  const reservation = await db.restaurantReservation.findFirst({
    where: { id: reservationId, botId }
  });
  if (!reservation) {
    return {
      success: false,
      errorCode: "reservation_not_found",
      errorMessage: "Reservation not found."
    };
  }
  if (!allowedCurrent.includes(reservation.status)) {
    return {
      success: false,
      errorCode: "invalid_status_transition",
      errorMessage: `Cannot transition reservation from ${reservation.status} to ${nextStatus}.`
    };
  }

  const data: any = { status: nextStatus };
  if (nextStatus === "CHECKED_IN") data.checkedInAt = new Date();
  if (nextStatus === "NO_SHOW") data.noShowMarkedAt = new Date();
  if (nextStatus === "COMPLETED") data.completedAt = new Date();
  if (nextStatus === "EXPIRED") data.expiredAt = new Date();
  const nextIsBlocking = BLOCKING_STATUSES.includes(nextStatus);
  const { blockedFrom, blockedUntil } = computeReservationAllocationWindow({
    startAt: reservation.startAt,
    endAt: reservation.endAt,
    bufferMinutes: reservation.bufferMinutes
  });

  await db.$transaction(async (tx: any) => {
    await tx.restaurantReservation.update({
      where: { id: reservationId },
      data
    });
    await tx.restaurantReservationTable.updateMany({
      where: { reservationId },
      data: {
        blockedFrom,
        blockedUntil,
        isBlocking: nextIsBlocking
      }
    });
    await tx.restaurantAuditLog.create({
      data: {
        botId,
        reservationId,
        action,
        actor,
        actorUserId
      }
    });
  });

  return { success: true };
}

export async function checkInRestaurantReservation(params: {
  botId: string;
  reservationId: string;
  actorUserId: string | null;
  actor?: RestaurantReservationActor;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  return updateReservationStatus({
    botId: params.botId,
    reservationId: params.reservationId,
    allowedCurrent: ["PENDING", "CONFIRMED"],
    nextStatus: "CHECKED_IN",
    action: "reservation.checked_in",
    actor: params.actor || "STAFF",
    actorUserId: params.actorUserId || null
  });
}

export async function completeRestaurantReservation(params: {
  botId: string;
  reservationId: string;
  actorUserId: string | null;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  return updateReservationStatus({
    botId: params.botId,
    reservationId: params.reservationId,
    allowedCurrent: ["CHECKED_IN", "CONFIRMED"],
    nextStatus: "COMPLETED",
    action: "reservation.completed",
    actor: "STAFF",
    actorUserId: params.actorUserId || null
  });
}

export async function markNoShowRestaurantReservation(params: {
  botId: string;
  reservationId: string;
  actorUserId: string | null;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  return updateReservationStatus({
    botId: params.botId,
    reservationId: params.reservationId,
    allowedCurrent: ["PENDING", "CONFIRMED"],
    nextStatus: "NO_SHOW",
    action: "reservation.no_show",
    actor: "STAFF",
    actorUserId: params.actorUserId || null
  });
}

export async function setRestaurantTableManualState(params: {
  botId: string;
  tableId: string;
  manualState: RestaurantTableManualState;
  note?: string;
  actorUserId: string | null;
}): Promise<{ success: boolean; errorCode?: string; errorMessage?: string }> {
  const table = await db.restaurantTable.findFirst({
    where: { id: params.tableId, botId: params.botId }
  });
  if (!table) {
    return {
      success: false,
      errorCode: "table_not_found",
      errorMessage: "Table not found."
    };
  }

  await db.$transaction(async (tx: any) => {
    await tx.restaurantTable.update({
      where: { id: params.tableId },
      data: {
        manualState: params.manualState,
        manualStateNote: params.note || null,
        manualStateUpdatedAt: new Date()
      }
    });
    await tx.restaurantAuditLog.create({
      data: {
        botId: params.botId,
        tableId: params.tableId,
        action: "table.manual_state.updated",
        actor: "STAFF",
        actorUserId: params.actorUserId || null,
        details: {
          manualState: params.manualState,
          note: params.note || null
        }
      }
    });
  });
  return { success: true };
}

export async function getCheckInReservationForToken(params: {
  token: string;
}): Promise<any | null> {
  const tokenHash = crypto.createHash("sha256").update(params.token).digest("hex");
  return db.restaurantReservation.findFirst({
    where: { checkInTokenHash: tokenHash },
    include: {
      bot: {
        select: {
          id: true,
          name: true
        }
      },
      tables: {
        include: {
          table: {
            include: { room: true }
          }
        }
      }
    }
  });
}
