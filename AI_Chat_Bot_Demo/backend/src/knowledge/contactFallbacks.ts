export type ContactFallbackLanguage = "en" | "it" | "es" | "de" | "fr";

export const CONTACT_FALLBACKS = {
  noVerified: {
    it: "Al momento non trovo un contatto verificato. Posso aiutarti a trovare la pagina contatti o guidarti passo passo.",
    en: "I could not find a verified contact right now. I can help you find the contact page or guide you step by step.",
    es: "Ahora mismo no encuentro un contacto verificado. Puedo ayudarte a encontrar la pagina de contacto o guiarte paso a paso.",
    de: "Ich finde im Moment keinen verifizierten Kontakt. Ich kann dir helfen, die Kontaktseite zu finden oder dich Schritt fuer Schritt zu fuehren.",
    fr: "Je ne trouve pas de contact verifie pour le moment. Je peux t'aider a trouver la page de contact ou te guider pas a pas."
  },
  contactPageOnly: {
    it: "Ho trovato una pagina contatti{urlPart}. Vuoi che ti estragga email e telefono da li?",
    en: "I found a contact page{urlPart}. Do you want me to extract email and phone details from it?",
    es: "Encontre una pagina de contacto{urlPart}. Quieres que te extraiga email y telefono desde alli?",
    de: "Ich habe eine Kontaktseite gefunden{urlPart}. Soll ich dir E-Mail und Telefon daraus herausziehen?",
    fr: "J'ai trouve une page de contact{urlPart}. Veux-tu que j'en extraie l'email et le telephone ?"
  },
  partnerClarify: {
    it: "Ti servono i contatti dell'azienda principale o di un partner specifico?",
    en: "Do you need the main company contacts or a specific partner?",
    es: "Necesitas los contactos de la empresa principal o de un socio especifico?",
    de: "Brauchst du die Kontakte des Hauptunternehmens oder eines bestimmten Partners?",
    fr: "As-tu besoin des contacts de l'entreprise principale ou d'un partenaire specifique ?"
  },
  conflictClarify: {
    it: "Ho trovato piu riferimenti di contatto con dati diversi. Vuoi che ti mostri entrambe le opzioni?",
    en: "I found multiple contact references with different details. Do you want me to show both options?",
    es: "Encontre varias referencias de contacto con datos diferentes. Quieres que te muestre ambas opciones?",
    de: "Ich habe mehrere Kontaktquellen mit unterschiedlichen Angaben gefunden. Soll ich dir beide Optionen zeigen?",
    fr: "J'ai trouve plusieurs references de contact avec des informations differentes. Veux-tu que je te montre les deux options ?"
  },
  intentClarify: {
    it: "Vuoi i contatti dell'azienda (email/telefono/pagina contatti) oppure informazioni generali?",
    en: "Do you need company contact details (email/phone/contact page) or general information?",
    es: "Necesitas los datos de contacto de la empresa (correo/telefono/pagina de contacto) o informacion general?",
    de: "Brauchst du Kontaktdaten des Unternehmens (E-Mail/Telefon/Kontaktseite) oder allgemeine Informationen?",
    fr: "As-tu besoin des coordonnees de l'entreprise (e-mail/telephone/page de contact) ou d'informations generales ?"
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
