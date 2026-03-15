export type ExtractedContacts = {
  emails: string[];
  phones: string[];
  contactUrls: string[];
  contactUrlCount: number;
  hasVerifiedContact: boolean;
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;
const CONTACT_URL_TOKENS = ["contact", "contatti", "contatto", "contattaci", "contacto"];
const PHONE_CONTEXT_RE = /\b(tel|telefono|phone|whatsapp|cellulare|cell|call|chiam)/i;
const PLACEHOLDER_EMAIL_DOMAIN_PATTERNS = [
  /^test\./i,
  /^mailinator\./i,
  /^ex\.com/i
];

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  const compact = value.replace(/[^\d+]/g, "");
  if (compact.startsWith("00") && compact.length > 4) {
    return `+${compact.slice(2)}`;
  }
  return compact;
}

function countDigits(value: string): number {
  return (value.match(/\d/g) || []).length;
}

function isLikelyPhone(value: string, context?: string): boolean {
  const digits = countDigits(value);
  if (digits < 8 || digits > 15) return false;
  if (!context) return false;
  return PHONE_CONTEXT_RE.test(context);
}

function isValidEmailDomain(domain: string): boolean {
  if (!domain || domain.length < 4) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;
  if (PLACEHOLDER_EMAIL_DOMAIN_PATTERNS.some((pattern) => pattern.test(domain))) {
    return false;
  }
  const tld = domain.split(".").pop() || "";
  if (!/^[a-z]{2,24}$/i.test(tld)) return false;
  return true;
}

function isValidEmailValue(value: string): boolean {
  const normalized = normalizeEmail(value);
  const at = normalized.indexOf("@");
  if (at <= 0 || at >= normalized.length - 1) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length < 1 || local.length > 64) return false;
  if (local.includes("..")) return false;
  if (!/^[a-z0-9._%+-]+$/i.test(local)) return false;
  return isValidEmailDomain(domain);
}

type ContactSourceInput = {
  id?: string | null;
  text: string;
  url?: string | null;
  trusted?: boolean;
};

export type ExtractedContactBySource = {
  resultId?: string | null;
  url?: string | null;
  trusted: boolean;
  contactLikeUrl: boolean;
  emails: string[];
  phones: string[];
};

export function extractContacts(params: {
  texts?: string[];
  urls?: string[];
  sources?: ContactSourceInput[];
}): ExtractedContacts {
  const { texts, urls, sources } = params;
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();
  const contactUrlSet = new Set<string>();

  const inputs: ContactSourceInput[] =
    sources && sources.length > 0
      ? sources
      : (texts || []).map((text, index) => ({
          text,
          url: urls?.[index] ?? null,
          trusted: false
        }));

  for (const source of inputs) {
    const text = source.text || "";
    if (!text) continue;
    const emails = text.match(EMAIL_RE) || [];
    emails.forEach((value) => {
      if (!isValidEmailValue(value)) return;
      emailSet.add(normalizeEmail(value));
    });

    const phones = text.match(PHONE_RE) || [];
    phones.forEach((value) => {
      const normalized = normalizePhone(value);
      const trusted =
        source.trusted ||
        (source.url
          ? CONTACT_URL_TOKENS.some((token) =>
              source.url!.toLowerCase().includes(token)
            )
          : false);
      if (isLikelyPhone(normalized, text) || (trusted && countDigits(normalized) >= 8)) {
        phoneSet.add(normalized);
      }
    });

    if (source.url) {
      const lower = source.url.toLowerCase();
      if (CONTACT_URL_TOKENS.some((token) => lower.includes(token))) {
        contactUrlSet.add(source.url);
      }
    }
  }

  const allUrls = (urls || []).filter(Boolean);
  for (const url of allUrls) {
    const lower = url.toLowerCase();
    if (CONTACT_URL_TOKENS.some((token) => lower.includes(token))) {
      contactUrlSet.add(url);
    }
  }

  const contactUrls = Array.from(contactUrlSet);

  return {
    emails: Array.from(emailSet),
    phones: Array.from(phoneSet),
    contactUrls,
    contactUrlCount: contactUrls.length,
    hasVerifiedContact: emailSet.size > 0 || phoneSet.size > 0 || contactUrls.length > 0
  };
}

export function extractContactsBySource(
  sources: ContactSourceInput[]
): ExtractedContactBySource[] {
  const outputs: ExtractedContactBySource[] = [];

  for (const source of sources) {
    const text = source.text || "";
    const emails = (text.match(EMAIL_RE) || [])
      .map(normalizeEmail)
      .filter((value) => isValidEmailValue(value));
    const phonesRaw = text.match(PHONE_RE) || [];
    const contactLikeUrl =
      !!source.url &&
      CONTACT_URL_TOKENS.some((token) =>
        source.url!.toLowerCase().includes(token)
      );
    const trusted = source.trusted === true || contactLikeUrl;

    const phones = phonesRaw
      .map(normalizePhone)
      .filter((value) => {
        if (isLikelyPhone(value, text)) return true;
        if (trusted && countDigits(value) >= 8) return true;
        return false;
      });

    outputs.push({
      resultId: source.id ?? null,
      url: source.url ?? null,
      trusted,
      contactLikeUrl,
      emails: Array.from(new Set(emails)),
      phones: Array.from(new Set(phones))
    });
  }

  return outputs;
}
