// services/bookingFieldCapture.ts

import { BookingDraft } from "./bookingDraftService";

export type BookingCaptureConfig = {
  requiredFields: string[];
  services: Array<{ name: string; aliases?: string[] }>;
};

type FieldCandidate = {
  field: "name" | "email" | "phone" | "service";
  value: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

const ACK_PHRASE_PATTERNS = [
  /\b(thank\s*you|thanks|thx|ty)\b/i,
  /\b(grazie|grazie\s*mille|ok\s*grazie)\b/i,
  /\b(gracias|muchas\s*gracias|mil\s*gracias)\b/i,
  /\b(ok|okay|okey|vale|va\s*bene|perfetto|perfecto|listo)\b/i,
  /\b(yes|no|si|s[ií]|claro|cierto|d'accordo|de\s*acuerdo)\b/i,
  /\b(ciao|hello|hola|buenas|buongiorno|buonasera|good\s*morning|good\s*afternoon|good\s*evening)\b/i
];

const ACK_WORDS = new Set(
  [
    "thanks",
    "thank",
    "you",
    "grazie",
    "gracias",
    "ok",
    "okay",
    "okey",
    "vale",
    "perfetto",
    "perfecto",
    "listo",
    "yes",
    "no",
    "si",
    "ciao",
    "hello",
    "hola",
    "buenas",
    "buongiorno",
    "buonasera"
  ].map((w) => w.toLowerCase())
);

const NAME_PARTICLES = new Set(
  [
    "de",
    "del",
    "della",
    "di",
    "da",
    "dos",
    "das",
    "van",
    "von",
    "la",
    "las",
    "los",
    "el",
    "al",
    "bin",
    "ibn",
    "mc",
    "mac",
    "st",
    "saint"
  ].map((w) => w.toLowerCase())
);

const DATE_TIME_WORDS = [
  "today",
  "tomorrow",
  "tonight",
  "today",
  "oggi",
  "domani",
  "stasera",
  "mañana",
  "manana",
  "hoy",
  "esta",
  "este",
  "alle",
  "ore",
  "a las",
  "at",
  "am",
  "pm"
];

const MONTH_WORDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre"
];

function foldDiacritics(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(input: string): string {
  return foldDiacritics(input)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsDateOrTimeWords(normalized: string): boolean {
  for (const w of DATE_TIME_WORDS) {
    if (normalized.includes(w)) return true;
  }
  for (const m of MONTH_WORDS) {
    if (normalized.includes(m)) return true;
  }
  return false;
}

function isAckPhrase(normalized: string): boolean {
  return ACK_PHRASE_PATTERNS.some((re) => re.test(normalized));
}

function extractEmail(text: string): FieldCandidate | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!match) return null;
  return {
    field: "email",
    value: match[0].trim(),
    confidence: "high",
    reason: "regex_email"
  };
}

function extractPhone(text: string): FieldCandidate | null {
  const matches = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/g);
  if (!matches || matches.length === 0) return null;

  const best = matches.sort((a, b) => b.length - a.length)[0];
  const digits = best.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;

  const normalized = normalizeText(text);
  if (containsDateOrTimeWords(normalized)) {
    if (digits.length <= 8) return null;
  }

  if (
    /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(best) ||
    /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/.test(best)
  ) {
    return null;
  }

  const hasLetters = /[A-Za-z]/.test(best);
  if (hasLetters) return null;

  const normalizedPhone = best.trim().replace(/\s+/g, " ");
  return {
    field: "phone",
    value: normalizedPhone,
    confidence: "high",
    reason: "regex_phone"
  };
}

function normalizeServiceText(value: string): string {
  return foldDiacritics(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(str: string): string[] {
  if (str.length < 2) return [];
  const grams: string[] = [];
  for (let i = 0; i < str.length - 1; i++) {
    grams.push(str.slice(i, i + 2));
  }
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  if (aGrams.length === 0 || bGrams.length === 0) return 0;

  const bCounts = new Map<string, number>();
  for (const gram of bGrams) {
    bCounts.set(gram, (bCounts.get(gram) || 0) + 1);
  }

  let matches = 0;
  for (const gram of aGrams) {
    const count = bCounts.get(gram) || 0;
    if (count > 0) {
      matches += 1;
      bCounts.set(gram, count - 1);
    }
  }

  return (2 * matches) / (aGrams.length + bGrams.length);
}

function extractService(
  text: string,
  services: Array<{ name: string; aliases?: string[] }>
): FieldCandidate | null {
  if (!services || services.length === 0) return null;
  const normalizedInput = normalizeServiceText(text);
  if (!normalizedInput) return null;

  type Scored = { service: { name: string; aliases?: string[] }; score: number };
  const scored: Scored[] = services.map((service) => {
    const candidates = [service.name, ...(service.aliases || [])];
    let best = 0;
    for (const candidate of candidates) {
      const normalizedCandidate = normalizeServiceText(candidate);
      if (!normalizedCandidate) continue;
      if (normalizedCandidate === normalizedInput) {
        best = 1;
        break;
      }
      const score = diceCoefficient(normalizedInput, normalizedCandidate);
      if (score > best) best = score;
    }
    return { service, score: best };
  });

  const ranked = scored.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return null;

  const threshold = 0.82;
  if (best.score < threshold) return null;
  if (second && second.score >= best.score - 0.05) return null;

  const confidence = best.score >= 0.92 ? "high" : "medium";
  return {
    field: "service",
    value: best.service.name,
    confidence,
    reason: `service_score_${best.score.toFixed(2)}`
  };
}

function extractName(text: string): FieldCandidate | null {
  const original = text.trim();
  if (original.length < 2 || original.length > 60) return null;

  if (/@/.test(original)) return null;
  if (/[0-9]/.test(original)) return null;

  const normalized = normalizeText(original);
  if (!normalized) return null;

  if (isAckPhrase(normalized)) return null;
  if (containsDateOrTimeWords(normalized)) return null;

  const tokens = original.match(/[A-Za-z\u00C0-\u017F'’]+/g);
  if (!tokens || tokens.length === 0) return null;

  const normalizedTokens = tokens.map((t) => normalizeText(t));
  const nonParticles = normalizedTokens.filter((t) => !NAME_PARTICLES.has(t));
  if (nonParticles.length === 0) return null;

  const allAckTokens = normalizedTokens.every((t) => ACK_WORDS.has(t));
  if (allAckTokens) return null;

  const ackTokenCount = normalizedTokens.filter((t) => ACK_WORDS.has(t)).length;
  if (ackTokenCount >= Math.ceil(normalizedTokens.length / 2)) return null;

  const capitalizedCount = tokens.filter((t) => {
    const first = t[0];
    return first && first.toUpperCase() === first && first.toLowerCase() !== first;
  }).length;

  const avgLen =
    nonParticles.reduce((sum, t) => sum + t.length, 0) / nonParticles.length;
  const hasShortToken = nonParticles.some((t) => t.length < 2);

  let score = 0;
  if (capitalizedCount > 0) score += 2;
  if (nonParticles.length >= 2) score += 1;
  if (avgLen >= 3) score += 1;
  if (!hasShortToken) score += 1;

  if (score >= 4) {
    return {
      field: "name",
      value: original,
      confidence: "high",
      reason: "name_score_high"
    };
  }

  if (score >= 2) {
    return {
      field: "name",
      value: original,
      confidence: "medium",
      reason: "name_score_medium"
    };
  }

  return null;
}

function hasExplicitCue(field: FieldCandidate["field"], normalized: string): boolean {
  if (field === "email") {
    return /\b(email|e-mail|mail|correo)\b/.test(normalized);
  }
  if (field === "phone") {
    return /\b(telefono|cellulare|cell|phone|tel|movil|m[oó]vil)\b/.test(
      normalized
    );
  }
  if (field === "service") {
    return /\b(servizio|trattamento|service|servicio|treatment)\b/.test(
      normalized
    );
  }
  return /\b(mi chiamo|sono|my name is|this is|me llamo|soy)\b/.test(normalized);
}

function getMissingFields(
  draft: BookingDraft | null | undefined,
  bookingCfg: BookingCaptureConfig
): Array<FieldCandidate["field"]> {
  const missing: Array<FieldCandidate["field"]> = [];
  const anyDraft: any = draft || {};

  for (const field of bookingCfg.requiredFields) {
    if (field === "datetime") continue;
    if (field === "name" || field === "email" || field === "phone" || field === "service") {
      const value = anyDraft[field];
      if (!value || (typeof value === "string" && value.trim().length === 0)) {
        missing.push(field);
      }
    }
  }

  return missing;
}

export function detectBookingFieldUpdates(params: {
  message: string;
  bookingCfg: BookingCaptureConfig;
  existingDraft: BookingDraft | null | undefined;
  debug?: boolean;
  debugContext?: { slug?: string; conversationId?: string };
}): Record<string, string> {
  const { message, bookingCfg, existingDraft, debug, debugContext } = params;
  const trimmed = (message || "").trim();
  if (!trimmed) return {};
  if (trimmed.length > 200) return {};

  const normalized = normalizeText(trimmed);

  const candidates: FieldCandidate[] = [];
  const email = extractEmail(trimmed);
  if (email) candidates.push(email);
  const phone = extractPhone(trimmed);
  if (phone) candidates.push(phone);
  const service = extractService(trimmed, bookingCfg.services);
  if (service) candidates.push(service);
  const name = extractName(trimmed);
  if (name) candidates.push(name);

  if (candidates.length === 0) return {};

  const updates: Record<string, string> = {};
  const missing = getMissingFields(existingDraft, bookingCfg);

  for (const candidate of candidates) {
    const alreadySet = (existingDraft as any)?.[candidate.field];
    if (alreadySet && !hasExplicitCue(candidate.field, normalized)) {
      continue;
    }

    if (candidate.confidence === "high") {
      updates[candidate.field] = candidate.value;
    }
  }

  if (Object.keys(updates).length > 0) {
    if (debug) {
      console.log("📘 [BookingCapture] updates", {
        slug: debugContext?.slug,
        conversationId: debugContext?.conversationId,
        updates,
        candidates: candidates.map((c) => ({
          field: c.field,
          value: c.value,
          confidence: c.confidence,
          reason: c.reason
        }))
      });
    }
    return updates;
  }

  if (missing.length === 1) {
    const expected = missing[0];
    const expectedCandidate = candidates.find((c) => c.field === expected);
    if (expectedCandidate && expectedCandidate.confidence === "medium") {
      updates[expected] = expectedCandidate.value;
      if (debug) {
        console.log("📘 [BookingCapture] updates (fallback)", {
          slug: debugContext?.slug,
          conversationId: debugContext?.conversationId,
          updates,
          candidates: candidates.map((c) => ({
            field: c.field,
            value: c.value,
            confidence: c.confidence,
            reason: c.reason
          }))
        });
      }
    }
  }

  if (debug && Object.keys(updates).length === 0) {
    console.log("📘 [BookingCapture] no updates", {
      slug: debugContext?.slug,
      conversationId: debugContext?.conversationId,
      candidates: candidates.map((c) => ({
        field: c.field,
        value: c.value,
        confidence: c.confidence,
        reason: c.reason
      }))
    });
  }

  return updates;
}
