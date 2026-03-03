const STOPWORDS_EN = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'about',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'what',
  'why',
  'how',
  'where',
  'when',
  'who',
  'which',
]);

const STOPWORDS_IT = new Set([
  'a',
  'al',
  'alla',
  'alle',
  'allo',
  'ai',
  'agli',
  'che',
  'chi',
  'cosa',
  'cos',
  'cose',
  'come',
  'dove',
  'quando',
  'quale',
  'quali',
  'un',
  'uno',
  'una',
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'e',
  'o',
  'di',
  'del',
  'della',
  'dei',
  'delle',
  'è',
  'sono',
  'essere',
  'per',
  'su',
  'con',
]);

const STOPWORDS_ES = new Set([
  'a',
  'al',
  'la',
  'las',
  'el',
  'los',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'de',
  'del',
  'para',
  'por',
  'en',
  'es',
  'son',
  'ser',
  'que',
  'como',
  'donde',
  'cuando',
  'quien',
  'quienes',
  'cual',
  'cuales',
  'qué',
  'cómo',
  'dónde',
  'cuándo',
  'quién',
  'cuál',
]);

export function resolveFtsConfig(input?: string): {
  column: string;
  config: string;
  language: 'en' | 'it' | 'es' | 'simple';
} {
  const normalized = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (normalized === 'en' || normalized === 'english') {
    return { column: 'search_tsv_en', config: 'english', language: 'en' };
  }
  if (normalized === 'it' || normalized === 'italian') {
    return { column: 'search_tsv_it', config: 'italian', language: 'it' };
  }
  if (normalized === 'es' || normalized === 'spanish') {
    return { column: 'search_tsv_es', config: 'spanish', language: 'es' };
  }
  return { column: 'search_tsv', config: 'simple', language: 'simple' };
}

function normalizeToken(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function buildFallbackTsQuery(input: string, language: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);

  const stopwords =
    language === 'en'
      ? STOPWORDS_EN
      : language === 'it'
        ? STOPWORDS_IT
        : language === 'es'
          ? STOPWORDS_ES
          : STOPWORDS_EN;

  const filtered = Array.from(
    new Set(
      tokens.filter((t) => t.length >= 3 && !stopwords.has(t)),
    ),
  );

  if (filtered.length === 0) return null;

  const terms = filtered.map((t) => (t.length >= 4 ? `${t}:*` : t));
  return terms.join(' | ');
}
