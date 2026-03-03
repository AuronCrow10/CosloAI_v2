const PARTNER_TOKENS = ["partner", "partners", "collaborazioni", "colaboraciones"];
const CONTACT_TOKENS = ["contact", "contatti", "contatto", "contattaci", "contacto"];

export type ContactSourceKind = "main" | "partner" | "unknown";

export function classifyContactSource(params: {
  url?: string | null;
  text?: string | null;
  preferPartnerSources?: boolean;
}): ContactSourceKind {
  const url = (params.url || "").toLowerCase();
  const text = (params.text || "").toLowerCase();

  const hasPartner = PARTNER_TOKENS.some((t) => url.includes(t) || text.includes(t));
  const hasContact = CONTACT_TOKENS.some((t) => url.includes(t) || text.includes(t));

  if (hasPartner && !hasContact) return "partner";
  if (hasContact && !hasPartner) return "main";
  if (hasPartner && hasContact) return params.preferPartnerSources ? "partner" : "main";
  return "unknown";
}
