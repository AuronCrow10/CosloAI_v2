// services/bookingFieldCapture.ts

import { BookingDraft } from "./bookingDraftService";

export type BookingCaptureConfig = {
  requiredFields: string[];
  services: Array<{ name: string; aliases?: string[] }>;
};

type BookingCaptureContext = {
  bookingFlowActive?: boolean;
  assistantAskedForName?: boolean;
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

const NAME_STOPWORDS = new Set(
  [
    // IT
    "capisco",
    "devo",
    "sviluppare",
    "voglio",
    "vorrei",
    "prenotare",
    "consulenza",
    "appuntamento",
    "informazioni",
    "aiuto",
    "perche",
    "quindi",
    "allora",
    "oggi",
    "domani",
    // EN
    "understand",
    "need",
    "build",
    "develop",
    "want",
    "would",
    "like",
    "book",
    "appointment",
    "consultation",
    "information",
    "help",
    "today",
    "tomorrow",
    // ES
    "entiendo",
    "necesito",
    "desarrollar",
    "quiero",
    "gustaria",
    "reservar",
    "cita",
    "consulta",
    "informacion",
    "ayuda",
    "hoy",
    "manana",
    // DE
    "verstehe",
    "brauche",
    "entwickeln",
    "mochte",
    "buchen",
    "termin",
    "beratung",
    "informationen",
    "hilfe",
    "heute",
    "morgen",
    // FR
    "comprends",
    "besoin",
    "developper",
    "veux",
    "voudrais",
    "reserver",
    "rendez",
    "vous",
    "consultation",
    "informations",
    "aide",
    "aujourd",
    "demain",
    // Generic technical terms often found in requests, not names
    "saas",
    "software",
    "servizio",
    "service"
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

const NAME_CONNECTOR_RE =
  /\b(?:and|e|y|und|et|ma|pero|but|because|perche|porque|weil|car|that|che|que)\b/i;

const NAME_SPLIT_PUNCTUATION_RE = /[\n,.;:!?()\[\]{}<>]/;

const NAME_EXPLICIT_CUE_PATTERNS: Array<{ pattern: RegExp; weak: boolean }> = [
  // Italian
  { pattern: /\bmi\s+chiamo\s+(.+)/i, weak: false },
  { pattern: /\bil\s+mio\s+nome\s+e['’]?\s+(.+)/i, weak: false },
  { pattern: /\bpuoi\s+chiamarmi\s+(.+)/i, weak: false },
  { pattern: /\bchiamami\s+(.+)/i, weak: false },
  { pattern: /^(?:io\s+)?sono\s+(.+)$/i, weak: true },

  // English
  { pattern: /\bmy\s+name\s+is\s+(.+)/i, weak: false },
  { pattern: /\bi\s+am\s+called\s+(.+)/i, weak: false },
  { pattern: /\byou\s+can\s+call\s+me\s+(.+)/i, weak: false },
  { pattern: /\bcall\s+me\s+(.+)/i, weak: false },
  { pattern: /\bthis\s+is\s+(.+)/i, weak: true },
  { pattern: /^(?:i\s+am|i['’]m)\s+(.+)$/i, weak: true },

  // Spanish
  { pattern: /\bme\s+llamo\s+(.+)/i, weak: false },
  { pattern: /\bmi\s+nombre\s+es\s+(.+)/i, weak: false },
  { pattern: /\bpuedes\s+llamarme\s+(.+)/i, weak: false },
  { pattern: /\bllamame\s+(.+)/i, weak: false },
  { pattern: /^(?:yo\s+)?soy\s+(.+)$/i, weak: true },

  // German
  { pattern: /\bich\s+hei(?:ss|ß)e\s+(.+)/i, weak: false },
  { pattern: /\bmein\s+name\s+ist\s+(.+)/i, weak: false },
  { pattern: /\bnenn\s+mich\s+(.+)/i, weak: false },
  { pattern: /\bnennen\s+sie\s+mich\s+(.+)/i, weak: false },
  { pattern: /^(?:ich\s+bin)\s+(.+)$/i, weak: true },

  // French
  { pattern: /\bje\s+m['’]appelle\s+(.+)/i, weak: false },
  { pattern: /\bmon\s+nom\s+est\s+(.+)/i, weak: false },
  { pattern: /\btu\s+peux\s+m['’]appeler\s+(.+)/i, weak: false },
  { pattern: /\bvous\s+pouvez\s+m['’]appeler\s+(.+)/i, weak: false },
  { pattern: /\bappelez[-\s]?moi\s+(.+)/i, weak: false },
  { pattern: /^(?:je\s+suis)\s+(.+)$/i, weak: true }
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

function extractNameTailFromCue(
  text: string
): { value: string; weakCue: boolean } | null {
  for (const cue of NAME_EXPLICIT_CUE_PATTERNS) {
    const match = text.match(cue.pattern);
    if (!match || !match[1]) continue;
    return { value: match[1].trim(), weakCue: cue.weak };
  }
  return null;
}

function cleanupNameTail(raw: string): string {
  let value = raw
    .trim()
    .replace(/^[\"'“”‘’\-\s]+/, "")
    .replace(/[\"'“”‘’]+$/g, "");

  const punctuationMatch = value.search(NAME_SPLIT_PUNCTUATION_RE);
  if (punctuationMatch >= 0) {
    value = value.slice(0, punctuationMatch).trim();
  }

  const connectorMatch = value.search(NAME_CONNECTOR_RE);
  if (connectorMatch > 0) {
    value = value.slice(0, connectorMatch).trim();
  }

  return value.replace(/\s+/g, " ").trim();
}

function isLikelyNameValue(
  input: string,
  options?: {
    fromExplicitCue?: boolean;
    allowLowerCase?: boolean;
    weakCue?: boolean;
  }
): boolean {
  const fromExplicitCue = options?.fromExplicitCue === true;
  const allowLowerCase = options?.allowLowerCase === true;
  const weakCue = options?.weakCue === true;
  const original = input.trim();

  if (original.length < 2 || original.length > 60) return false;
  if (/@/.test(original)) return false;
  if (/\d/.test(original)) return false;
  if (/https?:\/\//i.test(original) || /\bwww\./i.test(original)) return false;

  // Name values should be short and sentence-free.
  if (NAME_SPLIT_PUNCTUATION_RE.test(original)) return false;
  if (/[^A-Za-z\u00C0-\u017F'’\-\s]/.test(original)) return false;

  const normalized = normalizeText(original);
  if (!normalized) return false;
  if (isAckPhrase(normalized)) return false;
  if (containsDateOrTimeWords(normalized)) return false;

  const tokens = original.match(/[A-Za-z\u00C0-\u017F]+(?:['’\-][A-Za-z\u00C0-\u017F]+)*/g);
  if (!tokens || tokens.length === 0) return false;

  const maxTokenCount = fromExplicitCue ? 5 : 4;
  if (tokens.length > maxTokenCount) return false;

  const normalizedTokens = tokens.map((token) => normalizeText(token));
  const nonParticles = normalizedTokens.filter((token) => !NAME_PARTICLES.has(token));
  if (nonParticles.length === 0) return false;
  if (nonParticles.some((token) => NAME_STOPWORDS.has(token))) return false;

  const hasVeryShortToken = nonParticles.some((token) => token.length < 2);
  if (hasVeryShortToken) return false;

  if (!fromExplicitCue) {
    const hasCapitalizedToken = tokens.some((token) => {
      const first = token[0];
      return first && first.toUpperCase() === first && first.toLowerCase() !== first;
    });

    if (!hasCapitalizedToken && !allowLowerCase) return false;
  } else if (weakCue) {
    const hasCapitalizedToken = tokens.some((token) => {
      const first = token[0];
      return first && first.toUpperCase() === first && first.toLowerCase() !== first;
    });
    // Generic cues like "I am"/"sono"/"je suis" are ambiguous:
    // require a stronger name shape to avoid sentence captures.
    if (!hasCapitalizedToken) return false;
    if (tokens.length > 3) return false;
  }

  return true;
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

function extractName(
  text: string,
  options?: { allowPlainCapture?: boolean; allowLowerCasePlain?: boolean }
): FieldCandidate | null {
  const original = text.trim();

  const fromExplicitCue = extractNameTailFromCue(original);
  if (fromExplicitCue) {
    const cleaned = cleanupNameTail(fromExplicitCue.value);
    if (
      isLikelyNameValue(cleaned, {
        fromExplicitCue: true,
        allowLowerCase: true,
        weakCue: fromExplicitCue.weakCue
      })
    ) {
      return {
        field: "name",
        value: cleaned,
        confidence: "high",
        reason: "name_explicit_self_identification"
      };
    }
  }

  if (!options?.allowPlainCapture) return null;

  const cleanedPlain = cleanupNameTail(original);
  if (
    isLikelyNameValue(cleanedPlain, {
      fromExplicitCue: false,
      allowLowerCase: options.allowLowerCasePlain === true
    })
  ) {
    return {
      field: "name",
      value: cleanedPlain,
      confidence: "high",
      reason: "name_plain_shape"
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
  return /\b(mi chiamo|il mio nome e|my name is|i am called|call me|this is|me llamo|mi nombre es|ich heisse|ich hei(?:ss|ß|s)e|mein name ist|je m'appelle|mon nom est)\b/.test(
    normalized
  );
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
  context?: BookingCaptureContext;
  debug?: boolean;
  debugContext?: { slug?: string; conversationId?: string };
}): Record<string, string> {
  const { message, bookingCfg, existingDraft, context, debug, debugContext } = params;
  const trimmed = (message || "").trim();
  if (!trimmed) return {};
  if (trimmed.length > 200) return {};

  const normalized = normalizeText(trimmed);
  const missing = getMissingFields(existingDraft, bookingCfg);
  const nameMissing = missing.includes("name");
  const allowPlainNameCapture =
    context?.assistantAskedForName === true ||
    (context?.bookingFlowActive === true && nameMissing && missing.length === 1);

  const candidates: FieldCandidate[] = [];
  const email = extractEmail(trimmed);
  if (email) candidates.push(email);
  const phone = extractPhone(trimmed);
  if (phone) candidates.push(phone);
  const service = extractService(trimmed, bookingCfg.services);
  if (service) candidates.push(service);
  const name = extractName(trimmed, {
    allowPlainCapture: allowPlainNameCapture,
    allowLowerCasePlain: context?.assistantAskedForName === true
  });
  if (name) candidates.push(name);

  if (candidates.length === 0) return {};

  const updates: Record<string, string> = {};

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
      if (expected === "name" && context?.assistantAskedForName !== true) {
        return updates;
      }
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
