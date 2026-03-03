import type { KnowledgeLanguage } from "./knowledgeLanguage";

export const KNOWLEDGE_OVERVIEW_NO_RESULTS: Record<KnowledgeLanguage, string> = {
  it: "Non ho ancora abbastanza contenuti indicizzati per darti una panoramica. Se mi dici cosa ti serve, provo ad aiutarti.",
  es: "Aún no tengo suficiente contenido indexado para darte una panorámica. Si me dices qué necesitas, intentaré ayudarte.",
  en: "I don't have enough indexed content yet to give an overview. If you tell me what you're looking for, I can try to help.",
  de: "Ich habe noch nicht genug indexierte Inhalte, um dir einen Überblick zu geben. Wenn du mir sagst, was du brauchst, versuche ich zu helfen.",
  fr: "Je n'ai pas encore assez de contenu indexé pour te donner un aperçu. Si tu me dis ce dont tu as besoin, je peux essayer d'aider."
};

export function getKnowledgeOverviewNoResultsMessage(
  lang?: string | null
): string {
  if (lang === "it" || lang === "es" || lang === "en" || lang === "de" || lang === "fr") {
    return KNOWLEDGE_OVERVIEW_NO_RESULTS[lang];
  }
  return KNOWLEDGE_OVERVIEW_NO_RESULTS.en;
}
