import { getChatCompletion } from "../openai/client";

export type KnowledgeLanguage = "en" | "it" | "es" | "de" | "fr";

type LlmLanguageResult = {
  language: KnowledgeLanguage | "unknown";
  confidence: number;
};

const LLM_LANGUAGE_CACHE = new Map<string, KnowledgeLanguage>();
const LLM_CONFIDENCE_THRESHOLD = 0.55;

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

function tokenizeWords(value: string): string[] {
  return foldDiacritics(value)
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

const LANGUAGE_HEURISTIC_MARKERS: Record<KnowledgeLanguage, Set<string>> = {
  it: new Set([
    "che",
    "non",
    "sono",
    "come",
    "dove",
    "quando",
    "quale",
    "quali",
    "avete",
    "servizi",
    "prezzo",
    "prezzi",
    "grazie",
    "ciao",
    "posso",
    "potete",
    "negli",
    "della",
    "delle",
    "degli"
  ]),
  en: new Set([
    "the",
    "and",
    "for",
    "with",
    "what",
    "where",
    "when",
    "how",
    "price",
    "prices",
    "thanks",
    "hello",
    "can",
    "does",
    "do",
    "you"
  ]),
  es: new Set([
    "que",
    "como",
    "donde",
    "cuando",
    "precio",
    "precios",
    "gracias",
    "hola",
    "puedo",
    "pueden",
    "tienen",
    "para",
    "con"
  ]),
  de: new Set([
    "was",
    "wie",
    "wo",
    "wann",
    "preis",
    "preise",
    "danke",
    "hallo",
    "kann",
    "koennen",
    "haben",
    "und",
    "mit"
  ]),
  fr: new Set([
    "quoi",
    "comment",
    "ou",
    "quand",
    "prix",
    "merci",
    "bonjour",
    "pouvez",
    "avez",
    "avec",
    "pour",
    "les",
    "des"
  ])
};

function detectLanguageWithHeuristics(message: string): KnowledgeLanguage | null {
  const tokens = tokenizeWords(message);
  if (tokens.length === 0) return null;

  const scored = (Object.keys(LANGUAGE_HEURISTIC_MARKERS) as KnowledgeLanguage[]).map(
    (lang) => {
      const markers = LANGUAGE_HEURISTIC_MARKERS[lang];
      let hits = 0;
      for (const token of tokens) {
        if (markers.has(token)) hits += 1;
      }
      return { lang, hits };
    }
  );

  scored.sort((a, b) => b.hits - a.hits);
  const best = scored[0];
  const second = scored[1];
  const coverage = best.hits / Math.max(1, tokens.length);
  const minCoverage = tokens.length >= 4 ? 0.35 : 0.5;

  if (best.hits < 2) return null;
  if (coverage < minCoverage && best.hits < 3) return null;
  if (second && best.hits <= second.hits) return null;

  return best.lang;
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
    "Detect the language used by the user.",
    "Evaluate the whole message (majority language), not single words.",
    "If mixed language, pick the language that covers most of the message.",
    "If no language clearly dominates (around >=60%) or the message is too short, return unknown."
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
      const confidence =
        typeof parsed.confidence === "number" ? parsed.confidence : 0;
      if (lang && confidence >= LLM_CONFIDENCE_THRESHOLD) {
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

  if (allowLLM) {
    const llmLang = await detectLanguageWithLLM(message, botId);
    if (llmLang) return llmLang;
  }

  const lower = foldDiacritics(message.trim().toLowerCase());
  if (lower && /[¿¡]/.test(message)) return "es";

  const heuristicLang = detectLanguageWithHeuristics(message);
  if (heuristicLang) return heuristicLang;

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
