import { getChatCompletion } from "../openai/client";

export type KnowledgeLanguage = "en" | "it" | "es" | "de" | "fr";

type LlmLanguageResult = {
  language: KnowledgeLanguage | "unknown";
  confidence: number;
};

const LLM_LANGUAGE_CACHE = new Map<string, KnowledgeLanguage>();

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
    const parsed = JSON.parse(raw) as Partial<LlmLanguageResult>;
    const lang = parsed.language;
    if (
      lang === "en" ||
      lang === "it" ||
      lang === "es" ||
      lang === "de" ||
      lang === "fr"
    ) {
      LLM_LANGUAGE_CACHE.set(cacheKey, lang);
      return lang;
    }
    return null;
  } catch {
    return null;
  }
}

export async function detectKnowledgeLanguage(params: {
  message: string;
  lockedLanguage?: string | null;
  routedLanguage?: string | null;
  botId?: string | null;
  allowLLM?: boolean;
}): Promise<KnowledgeLanguage> {
  const { message, lockedLanguage, routedLanguage, botId, allowLLM = true } = params;
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

  const lower = message.trim().toLowerCase();
  if (lower) {
    if (/[Â¿Â¡]/.test(lower)) return "es";
    const itHints = [
      "cosa",
      "che",
      "chi",
      "dove",
      "quando",
      "perche",
      "perchÃ©",
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
      "quÃ©",
      "quien",
      "quiÃ©n",
      "donde",
      "dÃ³nde",
      "cuando",
      "cuÃ¡ndo",
      "como",
      "cÃ³mo"
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
      "oÃ¹",
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
      "carrello",
      "prezzo",
      "quanto costa"
    ];
    const esSignals = [
      "hola",
      "gracias",
      "quiero",
      "carrito",
      "precio",
      "por favor"
    ];
    const deSignals = [
      "hallo",
      "danke",
      "ich moechte",
      "warenkorb",
      "preis",
      "bitte"
    ];
    const frSignals = [
      "bonjour",
      "salut",
      "merci",
      "je veux",
      "panier",
      "prix",
      "s'il vous plait",
      "svp"
    ];
    if (itSignals.some((token) => lower.includes(token))) return "it";
    if (esSignals.some((token) => lower.includes(token))) return "es";
    if (deSignals.some((token) => lower.includes(token))) return "de";
    if (frSignals.some((token) => lower.includes(token))) return "fr";
  }

  if (allowLLM) {
    const llmLang = await detectLanguageWithLLM(message, botId);
    if (llmLang) return llmLang;
  }

  return "en";
}
