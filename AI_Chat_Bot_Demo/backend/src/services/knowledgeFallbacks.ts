import type { KnowledgeLanguage } from "./knowledgeLanguage";

export const KNOWLEDGE_OVERVIEW_NO_RESULTS: Record<KnowledgeLanguage, string> = {
  it: "Al momento non ho abbastanza informazioni per darti una panoramica completa. Se mi dici cosa ti serve, ti aiuto volentieri.",
  es: "Ahora mismo no tengo suficiente informacion para darte una vision general completa. Si me dices que necesitas, te ayudo encantado.",
  en: "I do not have enough information yet to give a complete overview. If you tell me what you need, I can help.",
  de: "Ich habe im Moment nicht genug Informationen fuer einen vollstaendigen Ueberblick. Wenn du mir sagst, was du brauchst, helfe ich dir gerne.",
  fr: "Je n'ai pas encore assez d'informations pour te donner une vue d'ensemble complete. Dis-moi ce dont tu as besoin et je t'aide volontiers."
};

export function getKnowledgeOverviewNoResultsMessage(
  lang?: string | null
): string {
  if (lang === "it" || lang === "es" || lang === "en" || lang === "de" || lang === "fr") {
    return KNOWLEDGE_OVERVIEW_NO_RESULTS[lang];
  }
  return KNOWLEDGE_OVERVIEW_NO_RESULTS.en;
}
