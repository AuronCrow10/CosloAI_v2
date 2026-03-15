import { searchKnowledgeWithMeta } from "../knowledge/client";
import { searchKnowledgeOverview } from "../knowledge/overviewRetrieval";
import type { KnowledgeIntent } from "./knowledgeIntentClassifier";
import type { SearchKnowledgeParams, KnowledgeSearchResponse } from "../knowledge/client";

export type KnowledgeRetrievalSource = "overview_retrieval" | "raw_query_retrieval";
type RetrievalParams = Omit<SearchKnowledgeParams, "clientId" | "query" | "domain">;
type SupportedLang = "en" | "it" | "es" | "de" | "fr";

const COMMON_QUERY_STOPWORDS = [
  "a",
  "an",
  "the",
  "and",
  "to",
  "for",
  "with",
  "that",
  "this",
  "what",
  "when",
  "where",
  "who",
  "how",
  "please",
  "one",
  "about",
  "from",
  "your",
  "more",
  "info",
  "information",
  "specific",
  "specifics",
  "also",
  "detail",
  "details"
] as const;

const LANGUAGE_QUERY_STOPWORDS: Record<SupportedLang, readonly string[]> = {
  en: [
    "are",
    "you",
    "have",
    "can",
    "want",
    "know",
    "tell",
    "give",
    "could",
    "would",
    "should",
    "any",
    "me",
    "my"
  ],
  it: [
    "ciao",
    "grazie",
    "dimmi",
    "dammi",
    "come",
    "dove",
    "quando",
    "quale",
    "quali",
    "sono",
    "vuoi",
    "sapere",
    "informazioni",
    "informazione",
    "specifiche",
    "specifica",
    "specifico",
    "specifici",
    "dettaglio",
    "dettagli",
    "anche",
    "una",
    "uno",
    "un",
    "il",
    "lo",
    "la",
    "le",
    "gli",
    "di",
    "da",
    "su",
    "per",
    "con",
    "che",
    "avete",
    "vostri",
    "vostre",
    "dei",
    "degli",
    "delle",
    "della",
    "del",
    "sul",
    "sulla",
    "sulle",
    "sui",
    "nel",
    "nella",
    "nelle",
    "nei",
    "puoi",
    "posso",
    "potresti",
    "vorrei",
    "voglio"
  ],
  es: [
    "hola",
    "gracias",
    "dime",
    "dame",
    "como",
    "donde",
    "cuando",
    "cual",
    "cuales",
    "quieres",
    "quiero",
    "saber",
    "informacion",
    "informaciones",
    "especifico",
    "especifica",
    "especificos",
    "especificas",
    "detalle",
    "detalles",
    "tambien",
    "una",
    "uno",
    "un",
    "la",
    "las",
    "el",
    "los",
    "de",
    "del",
    "al",
    "por",
    "para",
    "con",
    "sobre",
    "que",
    "puedes",
    "podrias"
  ],
  fr: [
    "bonjour",
    "merci",
    "dis",
    "donne",
    "comment",
    "ou",
    "quand",
    "quel",
    "quelle",
    "quels",
    "quelles",
    "voulez",
    "veux",
    "savoir",
    "information",
    "informations",
    "specifique",
    "specifiques",
    "detail",
    "details",
    "aussi",
    "une",
    "un",
    "le",
    "la",
    "les",
    "de",
    "des",
    "du",
    "pour",
    "avec",
    "sur",
    "que",
    "pouvez",
    "pourriez",
    "vous",
    "moi"
  ],
  de: [
    "hallo",
    "danke",
    "sag",
    "sage",
    "gib",
    "bitte",
    "wie",
    "wo",
    "wann",
    "welche",
    "welcher",
    "welches",
    "mochtest",
    "willst",
    "wissen",
    "information",
    "informationen",
    "spezifisch",
    "spezifische",
    "detail",
    "details",
    "auch",
    "ein",
    "eine",
    "einen",
    "der",
    "die",
    "das",
    "den",
    "dem",
    "des",
    "zu",
    "zur",
    "zum",
    "mit",
    "und",
    "uber",
    "ueber",
    "kannst",
    "konntest",
    "du"
  ]
};

const QUERY_STOPWORDS_BY_LANG: Record<SupportedLang, Set<string>> = {
  en: new Set([...COMMON_QUERY_STOPWORDS, ...LANGUAGE_QUERY_STOPWORDS.en]),
  it: new Set([...COMMON_QUERY_STOPWORDS, ...LANGUAGE_QUERY_STOPWORDS.it]),
  es: new Set([...COMMON_QUERY_STOPWORDS, ...LANGUAGE_QUERY_STOPWORDS.es]),
  fr: new Set([...COMMON_QUERY_STOPWORDS, ...LANGUAGE_QUERY_STOPWORDS.fr]),
  de: new Set([...COMMON_QUERY_STOPWORDS, ...LANGUAGE_QUERY_STOPWORDS.de])
};

const ALL_QUERY_STOPWORDS = new Set(
  (Object.values(QUERY_STOPWORDS_BY_LANG) as Set<string>[])
    .flatMap((set) => Array.from(set))
);

const PRICING_TERMS = [
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "buy",
  "buying",
  "purchase",
  "purchasing",
  "quote",
  "prezzo",
  "prezzi",
  "costo",
  "costi",
  "acquisto",
  "acquistare",
  "compra",
  "comprare",
  "listino",
  "tariffe",
  "precio",
  "comprar",
  "achat",
  "acheter",
  "preise",
  "kauf",
  "kaufen",
  "prix"
];

const SPECS_TERMS = [
  "spec",
  "specs",
  "specification",
  "specifications",
  "feature",
  "features",
  "technical",
  "specifiche",
  "tecniche",
  "caratteristiche",
  "misure",
  "dimensioni",
  "ficha",
  "technik"
];

const CONTACT_TERMS = [
  "contact",
  "contacts",
  "email",
  "mail",
  "phone",
  "telefono",
  "contatti",
  "contacto",
  "kontakt",
  "contatto"
];

const CONTACT_ACTION_TERMS = [
  "call",
  "calling",
  "chiamare",
  "chiamata",
  "telefon",
  "llamar",
  "llamada",
  "appeler",
  "appel",
  "anrufen",
  "anruf"
];

const SCHEDULE_TERMS = [
  "orari",
  "orario",
  "ufficio",
  "uffici",
  "opening hours",
  "office hours",
  "business hours",
  "schedule",
  "availability",
  "available hours",
  "horario",
  "horarios",
  "horas de apertura",
  "heures",
  "horaire",
  "heures d'ouverture",
  "offnungszeiten",
  "oeffnungszeiten",
  "geschaftszeiten",
  "geschaeftszeiten"
];

const PRICING_EXPANSION: Record<SupportedLang, string> = {
  it: "prezzi listino costi prodotti servizi",
  en: "prices pricing costs products services",
  es: "precios tarifas costos productos servicios",
  de: "preise kosten produkt dienstleistung",
  fr: "prix tarifs couts produits services"
};

const SPECS_EXPANSION: Record<SupportedLang, string> = {
  it: "specifiche tecniche caratteristiche dettagli",
  en: "technical specifications features details",
  es: "especificaciones tecnicas caracteristicas detalles",
  de: "technische spezifikationen merkmale details",
  fr: "specifications techniques caracteristiques details"
};

const CONTACT_EXPANSION: Record<SupportedLang, string> = {
  it: "contatti email telefono assistenza",
  en: "contact email phone support",
  es: "contacto correo telefono soporte",
  de: "kontakt e mail telefon support",
  fr: "contact email telephone assistance"
};

const SCHEDULE_EXPANSION: Record<SupportedLang, string> = {
  it: "orari orario giorni settimana apertura chiusura uffici disponibilita",
  en: "hours schedule weekdays opening closing office availability",
  es: "horario horarios dias semana apertura cierre disponibilidad",
  de: "offnungszeiten zeiten wochentage geoffnet geschlossen verfugbarkeit",
  fr: "horaires jours semaine ouverture fermeture disponibilite"
};

const MAX_LEXICAL_QUERY_TOKENS = 10;
const LEXICAL_MAX_BOOST = 0.35;
const SUPPORT_BONUS_STEP = 0.06;
const SUPPORT_BONUS_MAX = 0.12;

function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value: string, lang?: SupportedLang): string[] {
  const stopwords = lang ? QUERY_STOPWORDS_BY_LANG[lang] : ALL_QUERY_STOPWORDS;
  return foldText(value)
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function hasContactSignal(normalized: string, rawMessage: string): boolean {
  if (includesAny(normalized, CONTACT_TERMS)) return true;
  if (includesAny(normalized, CONTACT_ACTION_TERMS)) return true;
  if (/@/.test(rawMessage)) return true;
  return /\b(how to contact|come contattar|como contactar|comment contacter|wie kontaktieren)\b/.test(
    normalized
  );
}

function hasScheduleSignal(normalized: string): boolean {
  if (includesAny(normalized, SCHEDULE_TERMS)) return true;
  return /\b(a che ora|what time|at what time|a que hora|a quelle heure|um wie viel uhr)\b/.test(
    normalized
  );
}

function normalizeLang(lang?: string): SupportedLang {
  if (lang === "it" || lang === "en" || lang === "es" || lang === "de" || lang === "fr") {
    return lang;
  }
  return "en";
}

function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const trimmed = q.trim();
    if (!trimmed) continue;
    const key = foldText(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function buildCompactTokenVariant(tokens: string[]): string | null {
  if (tokens.length < 2) return null;
  if (tokens.length <= 8) return tokens.join(" ");

  const head = tokens.slice(0, 4);
  const tail = tokens.slice(-4);
  return [...head, ...tail].join(" ");
}

function buildSpecificQueryVariants(params: {
  message: string;
  ftsLanguage?: "en" | "it" | "es" | "de" | "fr";
}): string[] {
  const { message, ftsLanguage } = params;
  const normalized = foldText(message);
  const lang = normalizeLang(ftsLanguage);
  const tokens = tokenize(message, lang);
  const variants: string[] = [message];
  const contactSignal = hasContactSignal(normalized, message);
  const scheduleSignal = hasScheduleSignal(normalized);

  if (includesAny(normalized, PRICING_TERMS)) {
    variants.push(PRICING_EXPANSION[lang]);
  }
  if (includesAny(normalized, SPECS_TERMS)) {
    variants.push(SPECS_EXPANSION[lang]);
  }
  if (contactSignal) {
    variants.push(CONTACT_EXPANSION[lang]);
  }
  if (scheduleSignal) {
    variants.push(SCHEDULE_EXPANSION[lang]);
  }

  const compactVariant = buildCompactTokenVariant(tokens);
  if (compactVariant) {
    variants.push(compactVariant);
  }

  return dedupeQueries(variants).slice(0, 3);
}

function isLexicalRerankEnabled(): boolean {
  return String(process.env.KNOWLEDGE_ENABLE_LEXICAL_RERANK || "true").toLowerCase() !== "false";
}

function buildBigrams(tokens: string[]): string[] {
  if (tokens.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function resultKey(result: KnowledgeSearchResponse["results"][number]): string {
  return result.id || `${result.url || "unknown"}#${String(result.chunkIndex ?? 0)}`;
}

function computeLexicalSignal(params: {
  queryTokens: string[];
  queryBigrams: string[];
  queryPhrase: string | null;
  queryNumericTokens: string[];
  resultText: string;
  resultUrl?: string;
}): {
  tokenCoverage: number;
  bigramCoverage: number;
  exactPhraseHit: boolean;
  numericCoverage: number;
  boost: number;
} {
  const mergedText = `${params.resultText || ""} ${params.resultUrl || ""}`.trim();
  const normalizedText = foldText(mergedText);
  const tokenSet = new Set(tokenize(mergedText));

  const tokenHits = params.queryTokens.reduce(
    (acc, token) => (tokenSet.has(token) ? acc + 1 : acc),
    0
  );
  const tokenCoverage =
    params.queryTokens.length > 0 ? tokenHits / params.queryTokens.length : 0;

  const bigramHits = params.queryBigrams.reduce(
    (acc, phrase) => (normalizedText.includes(phrase) ? acc + 1 : acc),
    0
  );
  const bigramCoverage =
    params.queryBigrams.length > 0 ? bigramHits / params.queryBigrams.length : 0;

  const exactPhraseHit =
    !!params.queryPhrase && params.queryPhrase.length >= 6 && normalizedText.includes(params.queryPhrase);

  const numericHits = params.queryNumericTokens.reduce(
    (acc, token) => (normalizedText.includes(token) ? acc + 1 : acc),
    0
  );
  const numericCoverage =
    params.queryNumericTokens.length > 0 ? numericHits / params.queryNumericTokens.length : 0;

  const lexicalRaw =
    tokenCoverage * 0.56 +
    bigramCoverage * 0.24 +
    (exactPhraseHit ? 0.16 : 0) +
    numericCoverage * 0.04;
  const boost = Math.min(LEXICAL_MAX_BOOST, lexicalRaw * LEXICAL_MAX_BOOST);

  return {
    tokenCoverage,
    bigramCoverage,
    exactPhraseHit,
    numericCoverage,
    boost
  };
}

function mergeRetrievalResponses(params: {
  responses: KnowledgeSearchResponse[];
  maxResults: number;
  queryVariants: string[];
  primaryQuery: string;
  queryLanguage: SupportedLang;
}): KnowledgeSearchResponse {
  const { responses, maxResults, queryVariants, primaryQuery, queryLanguage } = params;
  const byId = new Map<string, (KnowledgeSearchResponse["results"][number])>();
  const supportCounts = new Map<string, number>();

  for (const response of responses) {
    const seenInResponse = new Set<string>();
    for (const result of response.results || []) {
      const key = resultKey(result);
      const existing = byId.get(key);
      if (!existing || (result.score ?? 0) > (existing.score ?? 0)) {
        byId.set(key, result);
      }
      if (!seenInResponse.has(key)) {
        supportCounts.set(key, (supportCounts.get(key) || 0) + 1);
        seenInResponse.add(key);
      }
    }
  }

  const lexicalRerankEnabled = isLexicalRerankEnabled();
  const lexicalQueryTokens = lexicalRerankEnabled
    ? tokenize(primaryQuery, queryLanguage).slice(0, MAX_LEXICAL_QUERY_TOKENS)
    : [];
  const lexicalQueryBigrams = buildBigrams(lexicalQueryTokens);
  const lexicalQueryPhrase =
    lexicalQueryTokens.length >= 2 && lexicalQueryTokens.length <= 8
      ? lexicalQueryTokens.join(" ")
      : null;
  const lexicalQueryNumericTokens = lexicalQueryTokens.filter((token) => /\d/.test(token));
  const shouldApplyLexicalBoost = lexicalQueryTokens.length >= 2;

  const rankedResults = Array.from(byId.values())
    .map((result) => {
      const key = resultKey(result);
      const supportCount = supportCounts.get(key) || 0;
      const baseScore = result.score ?? 0;
      const lexicalSignal = shouldApplyLexicalBoost
        ? computeLexicalSignal({
            queryTokens: lexicalQueryTokens,
            queryBigrams: lexicalQueryBigrams,
            queryPhrase: lexicalQueryPhrase,
            queryNumericTokens: lexicalQueryNumericTokens,
            resultText: result.text || "",
            resultUrl: result.url || ""
          })
        : null;
      const supportBonus = Math.min(
        SUPPORT_BONUS_MAX,
        Math.max(0, supportCount - 1) * SUPPORT_BONUS_STEP
      );
      const lexicalBoost = lexicalSignal?.boost ?? 0;
      const blendedScore = baseScore + supportBonus + lexicalBoost;
      return {
        result,
        key,
        supportCount,
        baseScore,
        supportBonus,
        lexicalSignal,
        lexicalBoost,
        blendedScore
      };
    })
    .sort((a, b) => {
      if (b.blendedScore !== a.blendedScore) {
        return b.blendedScore - a.blendedScore;
      }
      const phraseA = a.lexicalSignal?.exactPhraseHit ? 1 : 0;
      const phraseB = b.lexicalSignal?.exactPhraseHit ? 1 : 0;
      if (phraseB !== phraseA) return phraseB - phraseA;
      if (b.supportCount !== a.supportCount) return b.supportCount - a.supportCount;
      return b.baseScore - a.baseScore;
    })
    .slice(0, Math.max(1, maxResults));

  const mergedResults = rankedResults.map((entry) => entry.result);

  const hasOk = responses.some((r) => r.retrievalStatus === "ok");
  const hasLow = responses.some((r) => r.retrievalStatus === "low_confidence");
  const noAnswerRecommended =
    responses.length > 0 && responses.every((r) => r.noAnswerRecommended === true);
  const levelRank: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  const bestLevel = responses
    .map((r) => r.confidence?.level)
    .filter((level): level is "high" | "medium" | "low" => !!level)
    .sort((a, b) => levelRank.indexOf(a) - levelRank.indexOf(b))[0];
  const bestScore = responses.reduce((acc, r) => {
    const score = r.confidence?.score;
    if (typeof score === "number" && score > acc) return score;
    return acc;
  }, 0);

  return {
    results: mergedResults,
    retrievalStatus: hasOk ? "ok" : hasLow ? "low_confidence" : undefined,
    noAnswerRecommended,
    confidence: bestLevel ? { level: bestLevel, score: bestScore } : { score: bestScore },
    debug: (() => {
      const baseDebug =
        queryVariants.length > 1
          ? {
              mode: "multi_query",
              queryVariants,
              responsesMerged: responses.length,
              mergedCount: mergedResults.length
            }
          : responses[0]?.debug;

      if (!shouldApplyLexicalBoost) return baseDebug;

      return {
        ...(baseDebug || {}),
        lexicalRerank: {
          enabled: lexicalRerankEnabled,
          queryTokens: lexicalQueryTokens,
          top: rankedResults.slice(0, 5).map((entry) => ({
            key: entry.key,
            supportCount: entry.supportCount,
            baseScore: entry.baseScore,
            supportBonus: entry.supportBonus,
            lexicalBoost: entry.lexicalBoost,
            blendedScore: entry.blendedScore,
            tokenCoverage: entry.lexicalSignal?.tokenCoverage ?? 0,
            bigramCoverage: entry.lexicalSignal?.bigramCoverage ?? 0,
            exactPhraseHit: entry.lexicalSignal?.exactPhraseHit ?? false
          }))
        }
      };
    })()
  };
}

function tuneRetrievalParamsByIntent(
  intent: KnowledgeIntent,
  params: RetrievalParams
): RetrievalParams {
  const tuned: RetrievalParams = { ...params };

  if (intent === "overview") {
    tuned.diversifySources = true;
    tuned.maxPerSource = Math.min(tuned.maxPerSource ?? 2, 1);
    tuned.candidateLimit = Math.max(tuned.candidateLimit ?? 30, 36);
    tuned.finalLimit = Math.max(tuned.finalLimit ?? 10, 12);
    tuned.adaptiveLimit = true;
    tuned.minLimit = Math.max(tuned.minLimit ?? 3, 4);
    tuned.maxLimit = Math.max(tuned.maxLimit ?? 5, 6);
  } else if (intent === "ambiguous") {
    tuned.diversifySources = true;
    tuned.maxPerSource = Math.min(tuned.maxPerSource ?? 2, 2);
  }

  return tuned;
}

export async function runKnowledgeRetrieval(params: {
  intent: KnowledgeIntent;
  message: string;
  clientId: string;
  domain?: string;
  ftsLanguage?: "en" | "it" | "es" | "de" | "fr";
  retrievalParams: RetrievalParams;
}): Promise<{
  source: KnowledgeRetrievalSource;
  response: KnowledgeSearchResponse;
}> {
  const { intent, message, clientId, domain, ftsLanguage, retrievalParams } = params;
  const retrievalLanguage = normalizeLang(ftsLanguage);
  const tunedParams = tuneRetrievalParamsByIntent(intent, retrievalParams);

  if (intent === "overview") {
    const response = await searchKnowledgeOverview({
      clientId,
      domain,
      retrievalParams: tunedParams,
      ftsLanguage
    });
    return { source: "overview_retrieval", response };
  }

  const queryVariants = buildSpecificQueryVariants({
    message,
    ftsLanguage: retrievalLanguage
  });

  const settled = await Promise.allSettled(
    queryVariants.map((query) =>
      searchKnowledgeWithMeta({
        clientId,
        domain,
        query,
        ...tunedParams,
        ftsLanguage
      })
    )
  );

  const responses: KnowledgeSearchResponse[] = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      responses.push(item.value);
    }
  }

  if (responses.length === 0) {
    const firstRejected = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected"
    );
    throw firstRejected?.reason || new Error("Knowledge retrieval failed");
  }

  const response = mergeRetrievalResponses({
    responses,
    maxResults: Math.max(1, tunedParams.finalLimit ?? 10),
    queryVariants,
    primaryQuery: message,
    queryLanguage: retrievalLanguage
  });
  return { source: "raw_query_retrieval", response };
}

export const __testing__ = {
  tuneRetrievalParamsByIntent,
  buildSpecificQueryVariants,
  mergeRetrievalResponses,
  computeLexicalSignal,
  buildCompactTokenVariant
};
