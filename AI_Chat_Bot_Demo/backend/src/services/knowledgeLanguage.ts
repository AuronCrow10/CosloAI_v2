import { getChatCompletion } from "../openai/client";

export type KnowledgeLanguage = "en" | "it" | "es" | "de" | "fr";

type LlmLanguageResult = {
  language: KnowledgeLanguage | "unknown";
  confidence: number;
};

const LLM_LANGUAGE_CACHE = new Map<string, KnowledgeLanguage>();

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

function normalizeLanguageTag(input: unknown): KnowledgeLanguage | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();

  if (
    value === "en" ||
    value === "it" ||
    value === "es" ||
    value === "de" ||
    value === "fr"
  ) {
    return value;
  }

  if (value.startsWith("it")) return "it";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("en")) return "en";

  return null;
}

function foldDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function detectLanguageWithLLM(
  message: string,
  botId?: string | null
): Promise<KnowledgeLanguage | null> {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const cacheKey = trimmed.toLowerCase();
  const cached = LLM_LANGUAGE_CACHE.get(cacheKey);
  if (cached) return cached;

  const system = [
    "You are a language detector.",
    "Return ONLY strict JSON with keys:",
    '{"language":"en|it|es|de|fr|unknown","confidence":0-1}',
    "Detect the user's message language.",
    "If the message is too short or ambiguous, use language=unknown."
  ].join(" ");

  try {
    const raw = await getChatCompletion({
      model: "gpt-4o-mini",
      maxTokens: 60,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ],
      usageContext: {
        botId: botId ?? undefined,
        operation: "language_detect"
      }
    });

    const jsonText = extractJsonObject(raw);
    if (jsonText) {
      const parsed = JSON.parse(jsonText) as Partial<LlmLanguageResult>;
      const lang = normalizeLanguageTag(parsed.language);
      if (lang) {
        LLM_LANGUAGE_CACHE.set(cacheKey, lang);
        return lang;
      }
    }

    const directLang = normalizeLanguageTag(raw);
    if (directLang) {
      LLM_LANGUAGE_CACHE.set(cacheKey, directLang);
      return directLang;
    }

    const inlineMatch = raw.match(/\b(en|it|es|de|fr)\b/i);
    if (inlineMatch) {
      const inlineLang = normalizeLanguageTag(inlineMatch[1]);
      if (inlineLang) {
        LLM_LANGUAGE_CACHE.set(cacheKey, inlineLang);
        return inlineLang;
      }
    }

    return null;
  } catch {
    return null;
  }
}

type ResolveLanguageParams = {
  message: string;
  lockedLanguage?: string | null;
  routedLanguage?: string | null;
  botId?: string | null;
  allowLLM?: boolean;
  defaultLanguage?: KnowledgeLanguage | null;
};

async function resolveKnowledgeLanguage(
  params: ResolveLanguageParams
): Promise<KnowledgeLanguage | null> {
  const {
    message,
    lockedLanguage,
    routedLanguage,
    botId,
    allowLLM = true,
    defaultLanguage = null
  } = params;

  if (
    lockedLanguage === "it" ||
    lockedLanguage === "es" ||
    lockedLanguage === "en" ||
    lockedLanguage === "de" ||
    lockedLanguage === "fr"
  ) {
    return lockedLanguage;
  }

  if (
    routedLanguage === "it" ||
    routedLanguage === "es" ||
    routedLanguage === "en" ||
    routedLanguage === "de" ||
    routedLanguage === "fr"
  ) {
    return routedLanguage;
  }

  const lower = foldDiacritics(message.trim().toLowerCase());
  if (lower) {
    if (/[¿¡]/.test(message)) return "es";

    const itHints = [
      "cosa",
      "che",
      "chi",
      "dove",
      "quando",
      "perche",
      "quali",
      "servizi",
      "offrite",
      "gestione",
      "posso",
      "potete",
      "prenotare"
    ];
    const esHints = [
      "que",
      "quien",
      "donde",
      "cuando",
      "como",
      "precio",
      "servicios"
    ];
    const deHints = [
      "was",
      "wer",
      "wo",
      "wann",
      "warum",
      "wie",
      "welche",
      "welcher",
      "welches"
    ];
    const frHints = [
      "quoi",
      "qui",
      "ou",
      "quand",
      "pourquoi",
      "comment",
      "quel",
      "quelle",
      "quels",
      "quelles"
    ];

    if (itHints.some((token) => new RegExp(`\\b${token}\\b`, "i").test(lower))) {
      return "it";
    }
    if (esHints.some((token) => new RegExp(`\\b${token}\\b`, "i").test(lower))) {
      return "es";
    }
    if (deHints.some((token) => new RegExp(`\\b${token}\\b`, "i").test(lower))) {
      return "de";
    }
    if (frHints.some((token) => new RegExp(`\\b${token}\\b`, "i").test(lower))) {
      return "fr";
    }

    const itSignals = [
      "ciao",
      "grazie",
      "vorrei",
      "prezzo",
      "quanto costa",
      "inviamela",
      "va bene",
      "perfetto",
      "daccordo"
    ];
    const esSignals = ["hola", "gracias", "quiero", "precio", "por favor"];
    const deSignals = ["hallo", "danke", "ich moechte", "preis", "bitte"];
    const frSignals = ["bonjour", "salut", "merci", "je veux", "prix", "svp"];

    if (itSignals.some((token) => lower.includes(token))) return "it";
    if (esSignals.some((token) => lower.includes(token))) return "es";
    if (deSignals.some((token) => lower.includes(token))) return "de";
    if (frSignals.some((token) => lower.includes(token))) return "fr";
  }

  if (allowLLM) {
    const llmLang = await detectLanguageWithLLM(message, botId);
    if (llmLang) return llmLang;
  }

  return defaultLanguage;
}

export async function detectKnowledgeLanguage(params: {
  message: string;
  lockedLanguage?: string | null;
  routedLanguage?: string | null;
  botId?: string | null;
  allowLLM?: boolean;
  defaultLanguage?: KnowledgeLanguage;
}): Promise<KnowledgeLanguage> {
  const resolved = await resolveKnowledgeLanguage({
    ...params,
    defaultLanguage: params.defaultLanguage ?? "en"
  });
  return resolved ?? "en";
}

export async function detectKnowledgeLanguageHint(params: {
  message: string;
  lockedLanguage?: string | null;
  routedLanguage?: string | null;
  botId?: string | null;
  allowLLM?: boolean;
}): Promise<KnowledgeLanguage | null> {
  return resolveKnowledgeLanguage({
    ...params,
    defaultLanguage: null
  });
}
