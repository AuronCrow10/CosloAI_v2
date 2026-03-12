import type { SearchResult } from '../types.js';

export interface HeuristicRerankOptions {
  enabled?: boolean;
}

export interface HeuristicRerankDebugRow {
  id: string;
  url: string;
  baseScore: number;
  adjustedScore: number;
  tokenCoverage: number;
  legalPenaltyApplied: boolean;
  qualityPenaltyApplied: boolean;
}

export interface HeuristicRerankDebug {
  applied: boolean;
  queryTokens: string[];
  coverageFilterApplied: boolean;
  coverageThreshold: number;
  filteredOutLowCoverage: number;
  rows: HeuristicRerankDebugRow[];
}

type QuerySignals = {
  hasTokens: boolean;
  wantsLegalPolicy: boolean;
  wantsContact: boolean;
  wantsPricing: boolean;
  wantsSpecs: boolean;
  wantsOverview: boolean;
  wantsShowcase: boolean;
};

const QUERY_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'is',
  'it',
  'for',
  'with',
  'that',
  'this',
  'what',
  'when',
  'where',
  'who',
  'how',
  'are',
  'you',
  'please',
  'can',
  'have',
  'from',
  'dimmi',
  'dammi',
  'come',
  'dove',
  'quando',
  'quale',
  'quali',
  'sono',
  'avete',
  'vostri',
  'vostre',
  'vostro',
  'dei',
  'degli',
  'delle',
  'della',
  'del',
  'dello',
  'che',
  'per',
  'una',
  'uno',
  'all',
  'your',
  'ours',
  'esta',
  'este',
  'estos',
  'estas',
  'para',
  'con',
  'los',
  'las',
  'des',
  'ciao',
  'grazie',
]);

const LEGAL_TERMS = [
  'privacy',
  'cookie',
  'policy',
  'terms',
  'legal',
  'gdpr',
  'trattamento-dati',
  'condizioni',
  'termini',
  'informativa',
];

const CONTACT_TERMS = ['email', 'mail', 'phone', 'telefono', 'contact', 'contatti', 'whatsapp'];
const PRICING_TERMS = ['price', 'pricing', 'cost', 'costo', 'prezzo', 'prezzi', 'quote', 'preventivo', 'noleggio'];
const SPECS_TERMS = ['spec', 'specifiche', 'tecniche', 'dimensioni', 'capacity', 'capacita', 'power', 'autonomia'];
const SHOWCASE_TERMS = [
  'portfolio',
  'realizzazioni',
  'gallery',
  'galleria',
  'case-study',
  'case_study',
  'project',
  'projects',
  'progetti',
];
const SERVICE_TERMS = ['servizi', 'services', 'about', 'about-us', 'chi-siamo', 'azienda', 'company'];
const OVERVIEW_TERMS = [
  'cosa sapete fare',
  'cosa fate',
  'chi siete',
  'in generale',
  'what you do',
  'what can you do',
  'what do you do',
  'about you',
];
const SHOWCASE_QUERY_TERMS = ['portfolio', 'realizzazioni', 'esempi', 'examples', 'case study', 'progetti'];

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(text: string): string[] {
  const normalized = foldText(text);
  const parts = normalized
    .split(/[^a-z0-9]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3 && !QUERY_STOPWORDS.has(p));
  return Array.from(new Set(parts)).slice(0, 12);
}

function includesAny(target: string, terms: string[]): boolean {
  return terms.some((term) => target.includes(term));
}

function buildQuerySignals(query: string, queryTokens: string[]): QuerySignals {
  const q = foldText(query);
  return {
    hasTokens: queryTokens.length > 0,
    wantsLegalPolicy: includesAny(q, LEGAL_TERMS),
    wantsContact: includesAny(q, CONTACT_TERMS) || /@/.test(query),
    wantsPricing: includesAny(q, PRICING_TERMS),
    wantsSpecs: includesAny(q, SPECS_TERMS),
    wantsOverview: includesAny(q, OVERVIEW_TERMS),
    wantsShowcase: includesAny(q, SHOWCASE_QUERY_TERMS),
  };
}

function estimateTokenCoverage(text: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const normalized = tokenize(text);
  if (normalized.length === 0) return 0;
  const tokenSet = new Set(normalized);
  let matched = 0;
  for (const token of queryTokens) {
    if (tokenSet.has(token)) matched += 1;
  }
  return matched / queryTokens.length;
}

function estimateNoiseRatio(text: string): number {
  if (!text) return 1;
  const compact = text.replace(/\s+/g, '');
  if (!compact) return 1;
  const symbols = compact.replace(/[a-zA-Z0-9]/g, '').length;
  return symbols / compact.length;
}

function hasPriceEvidence(text: string): boolean {
  const raw = text || '';
  const folded = foldText(raw);
  const hasPricingTerm = includesAny(folded, PRICING_TERMS);
  const hasCurrencyAmount =
    /(?:€|\$|£|\beur\b|\beuro\b|\busd\b|\bgbp\b)\s*\d/i.test(raw) ||
    /\b\d[\d.,]{1,}\s*(?:€|\$|£|\beur\b|\beuro\b|\busd\b|\bgbp\b)/i.test(raw);
  const hasPriceWordNearAmount =
    /\b(prezz(?:o|i)|cost(?:o|i)|price|prices|pricing|noleggio|acquisto|rent|rental|quote|preventivo|tariff(?:a|e)|prix|preise)\b.{0,24}\d/.test(
      folded,
    ) ||
    /\b\d[\d.,]{2,}\b.{0,24}\b(prezz(?:o|i)|cost(?:o|i)|price|prices|noleggio|acquisto|quote|preventivo|tariff(?:a|e)|prix|preise)\b/.test(
      folded,
    );
  const hasFromAmount =
    /\b(a partire da|da|from|starting from|ab|desde)\s+\d{1,3}(?:[.,]\d{3})+\b/.test(
      folded,
    );

  return (
    hasCurrencyAmount ||
    hasPriceWordNearAmount ||
    hasFromAmount ||
    (hasPricingTerm &&
      /\b(listino|pricing|prezz(?:o|i)|cost(?:o|i)|quote|preventivo|noleggio|acquisto|tariff(?:a|e))\b/.test(
        folded,
      ))
  );
}

function computeAdjustedScore(params: {
  result: SearchResult;
  queryTokens: string[];
  querySignals: QuerySignals;
}): {
  score: number;
  tokenCoverage: number;
  legalPenaltyApplied: boolean;
  qualityPenaltyApplied: boolean;
} {
  const { result, queryTokens, querySignals } = params;
  const baseScore = clamp(result.score ?? 0);
  const foldedUrl = foldText(result.url || '');
  const foldedText = foldText(result.text || '');
  const tokenCoverage = estimateTokenCoverage(result.text || '', queryTokens);
  const noiseRatio = estimateNoiseRatio(result.text || '');

  let adjusted = baseScore;
  adjusted += 0.16 * tokenCoverage;

  const isFaqLike = foldedUrl.includes('faq') || foldedText.includes('domande frequenti');
  if (isFaqLike) adjusted += 0.05;
  const isShowcaseDoc = includesAny(foldedUrl, SHOWCASE_TERMS);
  const isServiceDoc = includesAny(foldedUrl, SERVICE_TERMS) || includesAny(foldedText, ['chi siamo', 'about us', 'servizi', 'services']);
  if (querySignals.wantsOverview && isServiceDoc) adjusted += 0.1;

  if (querySignals.wantsPricing && includesAny(foldedText, PRICING_TERMS)) {
    adjusted += 0.08;
  }
  const isPricingDoc = hasPriceEvidence(result.text || '');
  if (querySignals.wantsPricing) {
    if (isPricingDoc) {
      adjusted += 0.12;
      if (includesAny(foldedUrl, ['prezz', 'pric', 'listino', 'faq'])) {
        adjusted += 0.04;
      }
    } else {
      adjusted -= 0.2;
    }
  }
  if (querySignals.wantsSpecs && includesAny(foldedText, SPECS_TERMS)) {
    adjusted += 0.07;
  }
  if (
    querySignals.wantsContact &&
    (includesAny(foldedUrl, CONTACT_TERMS) ||
      includesAny(foldedText, CONTACT_TERMS) ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(result.text || ''))
  ) {
    adjusted += 0.1;
  }

  const isLegalDoc = includesAny(foldedUrl, LEGAL_TERMS);
  const legalPenaltyApplied = isLegalDoc && !querySignals.wantsLegalPolicy;
  if (legalPenaltyApplied) {
    adjusted -= 0.2;
  }
  if (isShowcaseDoc && !querySignals.wantsShowcase) {
    adjusted -= 0.12;
  }

  let qualityPenaltyApplied = false;
  if ((result.text || '').trim().length < 90 || noiseRatio > 0.45) {
    adjusted -= 0.08;
    qualityPenaltyApplied = true;
  }

  return {
    score: clamp(adjusted),
    tokenCoverage,
    legalPenaltyApplied,
    qualityPenaltyApplied,
  };
}

export function applyHeuristicRerank(params: {
  query: string;
  results: SearchResult[];
  options?: HeuristicRerankOptions;
}): { results: SearchResult[]; debug: HeuristicRerankDebug } {
  const { query, results, options } = params;
  const enabled = options?.enabled !== false;
  const queryTokens = tokenize(query);
  const querySignals = buildQuerySignals(query, queryTokens);

  if (!enabled || results.length <= 1 || !querySignals.hasTokens) {
    return {
      results: results.slice(),
      debug: {
        applied: false,
        queryTokens,
        coverageFilterApplied: false,
        coverageThreshold: 0,
        filteredOutLowCoverage: 0,
        rows: [],
      },
    };
  }

  const rows = results.map((result) => {
    const details = computeAdjustedScore({ result, queryTokens, querySignals });
    return {
      result: { ...result, score: details.score },
      debug: {
        id: result.id,
        url: result.url,
        baseScore: clamp(result.score ?? 0),
        adjustedScore: details.score,
        tokenCoverage: details.tokenCoverage,
        legalPenaltyApplied: details.legalPenaltyApplied,
        qualityPenaltyApplied: details.qualityPenaltyApplied,
      } satisfies HeuristicRerankDebugRow,
    };
  });

  let orderedRows = rows;

  const coverageThreshold =
    querySignals.wantsContact || querySignals.wantsPricing || querySignals.wantsSpecs
      ? 0.1
      : querySignals.wantsOverview
        ? 0.08
        : 0.12;

  let coverageFilterApplied = false;
  let filteredOutLowCoverage = 0;

  if (
    queryTokens.length >= 3 &&
    !querySignals.wantsLegalPolicy &&
    !querySignals.wantsPricing &&
    !querySignals.wantsSpecs &&
    !querySignals.wantsContact
  ) {
    const filtered = rows.filter((row) => row.debug.tokenCoverage >= coverageThreshold);
    const shouldUseFiltered = querySignals.wantsContact ? filtered.length >= 1 : filtered.length >= 2;
    if (shouldUseFiltered) {
      orderedRows = filtered;
      coverageFilterApplied = true;
      filteredOutLowCoverage = rows.length - filtered.length;
    }
  }

  orderedRows.sort((a, b) => {
    if (b.result.score !== a.result.score) {
      return b.result.score - a.result.score;
    }
    return (b.result.text?.length ?? 0) - (a.result.text?.length ?? 0);
  });

  return {
    results: orderedRows.map((row) => row.result),
    debug: {
      applied: true,
      queryTokens,
      coverageFilterApplied,
      coverageThreshold,
      filteredOutLowCoverage,
      rows: orderedRows.map((row) => row.debug),
    },
  };
}
