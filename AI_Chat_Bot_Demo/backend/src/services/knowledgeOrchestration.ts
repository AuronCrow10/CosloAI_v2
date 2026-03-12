import { searchKnowledgeWithMeta } from "../knowledge/client";
import { searchKnowledgeOverview } from "../knowledge/overviewRetrieval";
import type { KnowledgeIntent } from "./knowledgeIntentClassifier";
import type { SearchKnowledgeParams, KnowledgeSearchResponse } from "../knowledge/client";

export type KnowledgeRetrievalSource = "overview_retrieval" | "raw_query_retrieval";
type RetrievalParams = Omit<SearchKnowledgeParams, "clientId" | "query" | "domain">;
type SupportedLang = "en" | "it" | "es" | "de" | "fr";

const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "when",
  "where",
  "who",
  "how",
  "are",
  "you",
  "please",
  "about",
  "from",
  "your",
  "have",
  "can",
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
  "avete",
  "vostri",
  "vostre",
  "dei",
  "degli",
  "delle",
  "della",
  "del",
  "des",
  "las",
  "los",
  "con",
  "por",
  "para"
]);

const PRICING_TERMS = [
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "quote",
  "prezzo",
  "prezzi",
  "costo",
  "costi",
  "listino",
  "tariffe",
  "precio",
  "preise",
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
  "technik",
  "details",
  "dettagli"
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

function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value: string): string[] {
  return foldText(value)
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
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

function buildSpecificQueryVariants(params: {
  message: string;
  ftsLanguage?: "en" | "it" | "es" | "de" | "fr";
}): string[] {
  const { message, ftsLanguage } = params;
  const normalized = foldText(message);
  const tokens = tokenize(message);
  const lang = normalizeLang(ftsLanguage);
  const variants: string[] = [message];

  if (tokens.length >= 2) {
    variants.push(tokens.slice(0, 6).join(" "));
  }

  if (includesAny(normalized, PRICING_TERMS)) {
    variants.push(PRICING_EXPANSION[lang]);
  }
  if (includesAny(normalized, SPECS_TERMS)) {
    variants.push(SPECS_EXPANSION[lang]);
  }
  if (includesAny(normalized, CONTACT_TERMS) || /@/.test(message)) {
    variants.push(CONTACT_EXPANSION[lang]);
  }

  return dedupeQueries(variants).slice(0, 3);
}

function mergeRetrievalResponses(params: {
  responses: KnowledgeSearchResponse[];
  maxResults: number;
  queryVariants: string[];
}): KnowledgeSearchResponse {
  const { responses, maxResults, queryVariants } = params;
  const byId = new Map<string, (KnowledgeSearchResponse["results"][number])>();
  const supportCounts = new Map<string, number>();

  for (const response of responses) {
    const seenInResponse = new Set<string>();
    for (const result of response.results || []) {
      const key = result.id || `${result.url || "unknown"}#${String(result.chunkIndex ?? 0)}`;
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

  const mergedResults = Array.from(byId.values())
    .sort((a, b) => {
      const keyA = a.id || `${a.url || "unknown"}#${String(a.chunkIndex ?? 0)}`;
      const keyB = b.id || `${b.url || "unknown"}#${String(b.chunkIndex ?? 0)}`;
      const supportA = supportCounts.get(keyA) || 0;
      const supportB = supportCounts.get(keyB) || 0;
      if (supportB !== supportA) return supportB - supportA;
      return (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, Math.max(1, maxResults));

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
    debug:
      queryVariants.length > 1
        ? {
            mode: "multi_query",
            queryVariants,
            responsesMerged: responses.length,
            mergedCount: mergedResults.length
          }
        : responses[0]?.debug
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
    ftsLanguage
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
    queryVariants
  });
  return { source: "raw_query_retrieval", response };
}

export const __testing__ = {
  tuneRetrievalParamsByIntent,
  buildSpecificQueryVariants,
  mergeRetrievalResponses
};
