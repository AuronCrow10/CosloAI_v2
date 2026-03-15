const PARTNER_TOKENS = [
  "partner",
  "partners",
  "collaborazioni",
  "colaboraciones",
  "partenaire",
  "partenaires",
  "distributor",
  "reseller"
];
const CONTACT_TOKENS = [
  "contact",
  "contatti",
  "contatto",
  "contattaci",
  "contacto",
  "kontakt",
  "contactez"
];
const COMPANY_TOKENS = [
  "about",
  "azienda",
  "company",
  "chi-siamo",
  "chi_siamo",
  "impressum",
  "legal",
  "sede",
  "office",
  "location",
  "headquarter"
];
const LOW_TRUST_TOKENS = [
  "privacy",
  "cookie",
  "terms",
  "condition",
  "sitemap",
  "feed",
  "blog",
  "news",
  "article",
  "post",
  "product",
  "shop",
  "catalog",
  "category",
  "tag",
  "cart",
  "checkout"
];
const ADDRESS_HINT_TOKENS = [
  "address",
  "indirizzo",
  "sede",
  "via ",
  "piazza",
  "street",
  "road",
  "city",
  "cap ",
  "zip ",
  "postcode"
];
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;

export type ContactSourceKind = "main" | "partner" | "unknown";

function normalizeText(value: string | null | undefined): string {
  return String(value || "").toLowerCase();
}

function hasToken(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function countLikelyPhones(text: string): number {
  const raw = text.match(PHONE_RE) || [];
  let count = 0;
  for (const candidate of raw) {
    const digits = (candidate.match(/\d/g) || []).length;
    if (digits >= 8 && digits <= 15) count += 1;
  }
  return count;
}

function countEmails(text: string): number {
  const emails = text.match(EMAIL_RE) || [];
  return new Set(emails.map((email) => email.trim().toLowerCase())).size;
}

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

export function scoreContactSourceReliability(params: {
  url?: string | null;
  text?: string | null;
  classification?: ContactSourceKind;
}): number {
  const url = normalizeText(params.url);
  const text = normalizeText(params.text);
  const classification = params.classification ?? classifyContactSource(params);

  let score = 0;
  if (classification === "main") score += 2;
  if (classification === "partner") score -= 2;

  if (hasToken(url, CONTACT_TOKENS)) score += 4;
  if (hasToken(text, CONTACT_TOKENS)) score += 2;
  if (hasToken(url, COMPANY_TOKENS)) score += 2;
  if (hasToken(text, COMPANY_TOKENS)) score += 1;
  if (hasToken(url, LOW_TRUST_TOKENS)) score -= 4;
  if (hasToken(text, LOW_TRUST_TOKENS)) score -= 1;

  const emailCount = Math.min(2, countEmails(text));
  const phoneCount = Math.min(2, countLikelyPhones(text));
  score += emailCount * 3;
  score += phoneCount * 2;
  if (emailCount > 0 && phoneCount > 0) score += 2;

  if (hasToken(text, ADDRESS_HINT_TOKENS) || hasToken(url, ADDRESS_HINT_TOKENS)) {
    score += 1;
  }

  return score;
}
