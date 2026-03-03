export type OverviewCoverageLanguage = "en" | "it" | "es" | "de" | "fr";

const OVERVIEW_COVERAGE_QUERIES: Record<OverviewCoverageLanguage, string[]> = {
  it: ["chi siamo", "servizi", "cosa facciamo", "come possiamo aiutarti"],
  en: ["about us", "services", "what we do", "how we help"],
  es: ["quienes somos", "servicios", "que hacemos", "como ayudamos"],
  de: ["über uns", "dienstleistungen", "was wir tun", "wie wir helfen"],
  fr: ["à propos", "services", "ce que nous faisons", "comment nous aidons"]
};

function normalizeLang(
  lang?: string | null
): OverviewCoverageLanguage {
  if (lang === "it" || lang === "en" || lang === "es" || lang === "de" || lang === "fr") return lang;
  return "en";
}

// Helper queries for overview-mode retrieval (not user-facing strings).
export function getOverviewCoverageQueries(lang?: string | null): string[] {
  const normalized = normalizeLang(lang);
  return OVERVIEW_COVERAGE_QUERIES[normalized].slice();
}
