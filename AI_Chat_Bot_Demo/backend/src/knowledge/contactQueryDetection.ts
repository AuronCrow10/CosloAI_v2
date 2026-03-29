import { getChatCompletion } from "../openai/client";

export type ContactDetection = {
  isContactQuery: boolean;
  contactSignals: string[];
  requestedFields: {
    phone: boolean;
    email: boolean;
    generic: boolean;
    partner: boolean;
  };
  confidence?: number;
  source?: "llm" | "heuristic";
  ambiguous?: boolean;
  llmUnavailable?: boolean;
};

type ContactIntentLlmResult = {
  isContactQuery: boolean;
  requestedFields: {
    phone?: boolean;
    email?: boolean;
    generic?: boolean;
    partner?: boolean;
  };
  confidence: number;
};

const CONTACT_INTENT_CACHE = new Map<string, ContactDetection>();
const CONTACT_INTENT_LLM_THRESHOLD = 0.65;

const EMAIL_CUES = ["email", "mail", "posta", "correo", "e-mail", "courriel"];
const PHONE_CUES = ["phone", "telefono", "tel", "movil", "telefon", "telephone", "whatsapp"];
const CONTACT_CUES = [
  "contact",
  "contatto",
  "contatti",
  "contattaci",
  "contacto",
  "contactanos",
  "kontakt",
  "contactez"
];
const HOW_TO_CONTACT = [
  "how to contact",
  "come contattar",
  "como contactar",
  "wie kontaktieren",
  "comment contacter"
];
const CONTACT_VERB_RE =
  /\b(contatt[a-z]*|contact[a-z]*|kontakt[a-z]*|contacter[a-z]*|llam[a-z]*)\b/i;
const PARTNER_CUES = [
  "partner",
  "partners",
  "collaborazioni",
  "colaboraciones",
  "partenaire",
  "partenaires"
];
const CONTACT_WORKFLOW_ACTION_RE =
  /\b(scriv|write|draft|redig|compose|prepar|invia|send|manda|enviar|envia|escrib|schreib|sende|entwurf|envoyer|rediger|preparer)\b/i;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cueMatches(text: string, cue: string): boolean {
  const trimmedCue = cue.trim();
  if (!trimmedCue) return false;
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegex(trimmedCue)}($|[^\\p{L}\\p{N}_])`,
    "iu"
  );
  return pattern.test(text);
}

function hasAny(text: string, cues: string[]): boolean {
  return cues.some((cue) => cueMatches(text, cue));
}

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function extractJsonObject(raw: string): string | null {
  const text = stripCodeFences(raw);
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}

function normalizeDetection(
  input: Partial<ContactIntentLlmResult>,
  source: "llm" | "heuristic",
  options?: { ambiguous?: boolean; llmUnavailable?: boolean }
): ContactDetection {
  const requested = input.requestedFields || {};
  const phone = requested.phone === true;
  const email = requested.email === true;
  const partner = requested.partner === true;
  const isContactQuery = input.isContactQuery === true;
  const generic =
    requested.generic === true ||
    (isContactQuery && !(phone || email));

  const contactSignals: string[] = [];
  if (email) contactSignals.push("email");
  if (phone) contactSignals.push("phone");
  if (generic) contactSignals.push("contact");
  if (partner) contactSignals.push("partner");

  return {
    isContactQuery,
    contactSignals,
    requestedFields: {
      phone,
      email,
      generic,
      partner
    },
    confidence:
      typeof input.confidence === "number" ? input.confidence : undefined,
    source,
    ambiguous: options?.ambiguous === true,
    llmUnavailable: options?.llmUnavailable === true
  };
}

export function detectContactQuery(message: string): ContactDetection {
  const text = normalize(message);
  if (!text) {
    return {
      isContactQuery: false,
      contactSignals: [],
      requestedFields: { phone: false, email: false, generic: false, partner: false },
      source: "heuristic",
      ambiguous: false,
      llmUnavailable: false
    };
  }

  const wantsEmail = hasAny(text, EMAIL_CUES);
  const numeroContext =
    /\bnumero\b/i.test(text) &&
    (/\b(telefono|tel|whatsapp|cell|chiamare|contatt)\b/i.test(text) ||
      hasAny(text, CONTACT_CUES));
  const wantsPhone = hasAny(text, PHONE_CUES) || numeroContext;
  const wantsContact =
    hasAny(text, CONTACT_CUES) ||
    hasAny(text, HOW_TO_CONTACT) ||
    CONTACT_VERB_RE.test(text);
  const wantsPartner = hasAny(text, PARTNER_CUES);

  const parsed = normalizeDetection(
    {
      isContactQuery: wantsEmail || wantsPhone || wantsContact,
      requestedFields: {
        phone: wantsPhone,
        email: wantsEmail,
        partner: wantsPartner,
        generic: (wantsEmail || wantsPhone || wantsContact) && !(wantsEmail || wantsPhone)
      },
      confidence: 0.6
    },
    "heuristic"
  );

  return parsed;
}

async function detectContactQueryWithLLM(params: {
  message: string;
  botId?: string | null;
}): Promise<ContactDetection | null> {
  const text = params.message.trim();
  if (!text) return null;

  const cacheKey = text.toLowerCase();
  const cached = CONTACT_INTENT_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const raw = await getChatCompletion({
      model: "gpt-4o-mini",
      maxTokens: 140,
      messages: [
        {
          role: "system",
          content:
            "Classify whether the user is asking for BUSINESS CONTACT DETAILS. " +
            "Return strict JSON only: " +
            '{"isContactQuery":true|false,"requestedFields":{"phone":bool,"email":bool,"generic":bool,"partner":bool},"confidence":0-1}. ' +
            "Rules: " +
            "1) True ONLY if user asks for contact details (email/phone/whatsapp/address/contact page) or asks how to contact. " +
            "2) If user asks to draft/write a message/email but does NOT ask for contact details, set isContactQuery=false. " +
            "3) If ambiguous, set isContactQuery=false and low confidence."
        },
        { role: "user", content: text }
      ],
      usageContext: {
        botId: params.botId ?? undefined,
        operation: "contact_intent_detect"
      }
    });

    const jsonText = extractJsonObject(raw);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as Partial<ContactIntentLlmResult>;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const requested = parsed.requestedFields || {};
    const hasRequestedSignals =
      requested.phone === true ||
      requested.email === true ||
      requested.generic === true ||
      requested.partner === true;
    const ambiguous =
      confidence > 0 &&
      confidence < CONTACT_INTENT_LLM_THRESHOLD &&
      (parsed.isContactQuery === true || hasRequestedSignals);
    const normalized = normalizeDetection(parsed, "llm", { ambiguous });

    if (normalized.isContactQuery && confidence < CONTACT_INTENT_LLM_THRESHOLD) {
      return {
        ...normalized,
        isContactQuery: false,
        contactSignals: [],
        requestedFields: {
          phone: false,
          email: false,
          generic: false,
          partner: false
        },
        ambiguous: true
      };
    }

    CONTACT_INTENT_CACHE.set(cacheKey, normalized);
    return normalized;
  } catch {
    return null;
  }
}

export async function detectContactQuerySmart(params: {
  message: string;
  botId?: string | null;
}): Promise<ContactDetection> {
  const heuristic = detectContactQuery(params.message);
  const text = normalize(params.message);

  // Gate the LLM call: only escalate when heuristic indicates potential ambiguity.
  const shouldEscalateToLlm =
    heuristic.requestedFields.partner === true ||
    (heuristic.requestedFields.email === true &&
      heuristic.requestedFields.phone === false &&
      CONTACT_WORKFLOW_ACTION_RE.test(text)) ||
    (heuristic.requestedFields.generic === true &&
      CONTACT_WORKFLOW_ACTION_RE.test(text));

  if (!shouldEscalateToLlm) {
    return heuristic;
  }

  const llm = await detectContactQueryWithLLM(params);
  if (llm) return llm;

  return {
    ...heuristic,
    llmUnavailable: true
  };
}
