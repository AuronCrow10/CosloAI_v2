export type ContactFallbackLanguage = "en" | "it" | "es" | "de" | "fr";

export const CONTACT_FALLBACKS = {
  noVerified: {
    it: "Non trovo nel contesto un contatto verificato. Posso aiutarti a trovare la pagina contatti o rispondere qui se mi dai più dettagli.",
    en: "I couldn't find a verified contact in the available content. I can help find the contact page or answer here if you share more details.",
    es: "No encuentro un contacto verificado en el contenido disponible. Puedo ayudarte a encontrar la página de contacto o responder aquí si me das más detalles.",
    de: "Ich konnte im verfügbaren Inhalt keinen verifizierten Kontakt finden. Ich kann dir helfen, die Kontaktseite zu finden oder hier antworten, wenn du mir mehr Details gibst.",
    fr: "Je n'ai pas trouvé de contact vérifié dans le contenu disponible. Je peux aider à trouver la page de contact ou répondre ici si tu me donnes plus de détails."
  },
  contactPageOnly: {
    it: "Nel contesto ho trovato una pagina contatti{urlPart}. Vuoi che ti indichi i dettagli specifici (email/telefono) da lì?",
    en: "I found a contact page in the available content{urlPart}. Do you want the specific details (email/phone) from there?",
    es: "Encontré una página de contacto en el contenido disponible{urlPart}. ¿Quieres los detalles específicos (correo/teléfono) de allí?",
    de: "Ich habe im verfügbaren Inhalt eine Kontaktseite gefunden{urlPart}. Möchtest du die konkreten Details (E-Mail/Telefon) von dort?",
    fr: "J'ai trouvé une page de contact dans le contenu disponible{urlPart}. Veux-tu les détails précis (email/téléphone) de là-bas ?"
  },
  partnerClarify: {
    it: "Ti servono i contatti dell'azienda principale o di un partner specifico?",
    en: "Do you need the main company contacts or a specific partner?",
    es: "¿Necesitas los contactos de la empresa principal o de un socio específico?",
    de: "Brauchst du die Kontakte des Hauptunternehmens oder eines bestimmten Partners?",
    fr: "As-tu besoin des contacts de l'entreprise principale ou d'un partenaire spécifique ?"
  }
} as const;

export function resolveContactFallback(
  lang: string | null | undefined,
  key: keyof typeof CONTACT_FALLBACKS,
  options?: { url?: string }
): string {
  const normalizedLang =
    lang === "it" || lang === "en" || lang === "es" || lang === "de" || lang === "fr"
      ? lang
      : "en";
  const template = CONTACT_FALLBACKS[key][normalizedLang];
  if (key === "contactPageOnly") {
    const urlPart = options?.url ? ` (${options.url})` : "";
    return template.replace("{urlPart}", urlPart);
  }
  return template;
}
