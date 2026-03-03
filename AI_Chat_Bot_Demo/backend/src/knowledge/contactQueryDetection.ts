export type ContactDetection = {
  isContactQuery: boolean;
  contactSignals: string[];
  requestedFields: {
    phone: boolean;
    email: boolean;
    generic: boolean;
    partner: boolean;
  };
};

const EMAIL_CUES = ["email", "mail", "posta", "correo", "e-mail", "courriel"];
const PHONE_CUES = ["phone", "telefono", "tel", "móvil", "movil", "telefon", "téléphone"];
const CONTACT_CUES = [
  "contact",
  "contatto",
  "contatti",
  "contattaci",
  "contacto",
  "contactanos",
  "kontakt",
  "contactez"
];
const HOW_TO_CONTACT = [
  "how to contact",
  "come contattar",
  "como contactar",
  "wie kontaktieren",
  "comment contacter"
];
const PARTNER_CUES = [
  "partner",
  "partners",
  "collaborazioni",
  "colaboraciones",
  "partenaire",
  "partenaires"
];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function hasAny(text: string, cues: string[]): boolean {
  return cues.some((cue) => text.includes(cue));
}

export function detectContactQuery(message: string): ContactDetection {
  const text = normalize(message);
  if (!text) {
    return {
      isContactQuery: false,
      contactSignals: [],
      requestedFields: { phone: false, email: false, generic: false, partner: false }
    };
  }

  const signals: string[] = [];
  const wantsEmail = hasAny(text, EMAIL_CUES);
  const numeroContext =
    /\bnumero\b/i.test(text) &&
    (/\b(telefono|tel|whatsapp|cell|chiamare|contatt)/i.test(text) ||
      hasAny(text, CONTACT_CUES));
  const wantsPhone = hasAny(text, PHONE_CUES) || numeroContext;
  const wantsContact = hasAny(text, CONTACT_CUES) || hasAny(text, HOW_TO_CONTACT);
  const wantsPartner = hasAny(text, PARTNER_CUES);

  if (wantsEmail) signals.push("email");
  if (wantsPhone) signals.push("phone");
  if (wantsContact) signals.push("contact");
  if (wantsPartner) signals.push("partner");

  const isContactQuery = wantsEmail || wantsPhone || wantsContact;
  const generic = isContactQuery && !(wantsEmail || wantsPhone);

  return {
    isContactQuery,
    contactSignals: signals,
    requestedFields: {
      phone: wantsPhone,
      email: wantsEmail,
      generic,
      partner: wantsPartner
    }
  };
}
