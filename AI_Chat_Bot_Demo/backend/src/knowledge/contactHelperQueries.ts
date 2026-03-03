export type ContactHelperLanguage = "en" | "it" | "es" | "de" | "fr";

const CONTACT_HELPER_QUERIES: Record<ContactHelperLanguage, string[]> = {
  it: ["contatti", "contattaci", "telefono email", "come contattarci"],
  en: ["contact", "contact us", "phone email", "how to contact"],
  es: ["contacto", "contactanos", "telefono correo", "como contactar"],
  de: ["kontakt", "kontaktieren", "telefon email", "wie kontaktieren"],
  fr: ["contact", "contactez-nous", "telephone email", "comment contacter"]
};

function normalizeLang(lang?: string | null): ContactHelperLanguage {
  if (lang === "it" || lang === "en" || lang === "es" || lang === "de" || lang === "fr") return lang;
  return "en";
}

// Helper queries for contact-mode retrieval (not user-facing strings).
export function getContactHelperQueries(lang?: string | null): string[] {
  const normalized = normalizeLang(lang);
  return CONTACT_HELPER_QUERIES[normalized].slice();
}
