export type RevenueAIIntent =
  | "SUPPORT"
  | "SHOPPING"
  | "PRICE_ONLY"
  | "SIZE_ONLY"
  | "SHIPPING_INFO"
  | "OTHER";

export type IntentClassification = {
  intent: RevenueAIIntent;
  confidence: number;
  signals: string[];
};

type Pattern = { re: RegExp; weight: number; label: string };

const SUPPORT_PATTERNS: Pattern[] = [
  { re: /\btracking\b/i, weight: 0.5, label: "tracking" },
  { re: /\btrack my order\b/i, weight: 0.6, label: "track_my_order" },
  { re: /\border status\b/i, weight: 0.6, label: "order_status" },
  { re: /\bwhere is my order\b/i, weight: 0.7, label: "where_order" },
  { re: /\brefund\b/i, weight: 0.5, label: "refund" },
  { re: /\breturn\b/i, weight: 0.5, label: "return" },
  { re: /\bexchange\b/i, weight: 0.4, label: "exchange" },
  { re: /\bcancel(lation)?\b/i, weight: 0.5, label: "cancel" },
  { re: /\bcomplaint|angry|upset|disappointed\b/i, weight: 0.6, label: "complaint" },
  { re: /\bissue|problem|broken|defective|missing|wrong item\b/i, weight: 0.6, label: "issue" },
  { re: /\bspedizione in ritardo|ritardo\b/i, weight: 0.5, label: "late_it" },
  { re: /\bordine|traccia il mio ordine|dov'è il mio ordine\b/i, weight: 0.7, label: "order_it" },
  { re: /\breso|rimborso|cambio\b/i, weight: 0.6, label: "return_it" }
];

const SHIPPING_PATTERNS: Pattern[] = [
  { re: /\bshipping\b/i, weight: 0.4, label: "shipping" },
  { re: /\bdelivery time\b/i, weight: 0.5, label: "delivery_time" },
  { re: /\bshipping cost\b/i, weight: 0.6, label: "shipping_cost" },
  { re: /\bspedizione\b/i, weight: 0.4, label: "spedizione" },
  { re: /\btempi di spedizione\b/i, weight: 0.6, label: "tempi_spedizione" },
  { re: /\bcosto spedizione\b/i, weight: 0.6, label: "costo_spedizione" },
  { re: /\bconsegna\b/i, weight: 0.4, label: "consegna" }
];

const PRICE_PATTERNS: Pattern[] = [
  { re: /\bprice\b/i, weight: 0.5, label: "price" },
  { re: /\bcost\b/i, weight: 0.4, label: "cost" },
  { re: /\bquanto costa\b/i, weight: 0.7, label: "quanto_costa" },
  { re: /\bprezzo\b/i, weight: 0.6, label: "prezzo" },
  { re: /(\$|€|eur|usd)\s?\d+/i, weight: 0.6, label: "currency_amount" }
];

const SIZE_PATTERNS: Pattern[] = [
  { re: /\bsize\b/i, weight: 0.5, label: "size" },
  { re: /\bfit\b/i, weight: 0.4, label: "fit" },
  { re: /\btaglia\b/i, weight: 0.6, label: "taglia" },
  { re: /\bmisura\b/i, weight: 0.5, label: "misura" }
];

const SHOPPING_PATTERNS: Pattern[] = [
  { re: /\bbuy|purchase|checkout|add to cart\b/i, weight: 0.6, label: "buy" },
  { re: /\bcarrello|acquista|comprare|compra|ordina|ordine\b/i, weight: 0.6, label: "buy_it" },
  { re: /\bwant this|i want to buy\b/i, weight: 0.7, label: "want_buy" }
];

const INDECISION_PATTERNS: RegExp[] = [
  /\bnot sure\b/i,
  /\bwhich\b/i,
  /\brecommend\b/i,
  /\bbest\b/i,
  /\bhelp me choose\b/i,
  /\bcompare\b/i,
  /\bdifference\b/i,
  /\bundecided\b/i,
  /\bcan't decide\b/i,
  /\bnon so\b/i,
  /\bquale\b/i,
  /\bmigliore\b/i,
  /\bconsigli(a|ami)\b/i,
  /\baiutami a scegliere\b/i,
  /\bnon riesco a decidere\b/i
];

const CLARIFIER_PATTERNS: RegExp[] = [
  /\bbudget\b/i,
  /\bprice range\b/i,
  /\buse case\b/i,
  /\busage\b/i,
  /\bpreference\b/i,
  /\bcolor\b/i,
  /\bmaterial\b/i,
  /\btaglia\b/i,
  /\bbudget\b/i,
  /\buso\b/i,
  /\bpreferenze\b/i,
  /\bcolore\b/i,
  /\bmateriale\b/i
];

const PRODUCT_CONTEXT_PATTERNS: RegExp[] = [
  /\/products\//i,
  /\badd to cart\b/i,
  /\bview product\b/i,
  /\bEcco 3 opzioni\b/i,
  /\bHere are 3 options\b/i,
  /\bProdotto\b/i,
  /\bProduct\b/i
];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function scorePatterns(text: string, patterns: Pattern[]): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  patterns.forEach((p) => {
    if (p.re.test(text)) {
      score += p.weight;
      signals.push(p.label);
    }
  });
  return { score: Math.min(1, score), signals };
}

export function classifyIntent(text: string): IntentClassification {
  const lower = normalize(text);
  if (!lower) {
    return { intent: "OTHER", confidence: 0, signals: [] };
  }

  const support = scorePatterns(lower, SUPPORT_PATTERNS);
  const shipping = scorePatterns(lower, SHIPPING_PATTERNS);
  const price = scorePatterns(lower, PRICE_PATTERNS);
  const size = scorePatterns(lower, SIZE_PATTERNS);
  const shopping = scorePatterns(lower, SHOPPING_PATTERNS);

  const candidates: Array<{ intent: RevenueAIIntent; score: number; signals: string[] }> = [
    { intent: "SUPPORT", score: support.score, signals: support.signals },
    { intent: "SHIPPING_INFO", score: shipping.score, signals: shipping.signals },
    { intent: "PRICE_ONLY", score: price.score, signals: price.signals },
    { intent: "SIZE_ONLY", score: size.score, signals: size.signals },
    { intent: "SHOPPING", score: shopping.score, signals: shopping.signals }
  ];

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];

  if (!top || top.score <= 0) {
    return { intent: "OTHER", confidence: 0, signals: [] };
  }

  return {
    intent: top.intent,
    confidence: Math.min(1, top.score),
    signals: top.signals
  };
}

export function detectIndecision(text: string): boolean {
  const lower = normalize(text);
  if (!lower) return false;
  return INDECISION_PATTERNS.some((re) => re.test(lower));
}

export function isAnswerComplete(reply: string): boolean {
  const lower = normalize(reply);
  if (!lower) return false;
  if (lower.includes("?")) return false;
  const incompletePatterns = [
    /\bnot sure\b/i,
    /\bnon so\b/i,
    /\bcan't\b/i,
    /\bcannot\b/i,
    /\bneed more\b/i,
    /\bcan you\b/i,
    /\bcould you\b/i,
    /\bpuoi\b/i,
    /\bpotresti\b/i,
    /\bservono\b/i,
    /\bmi serve\b/i,
    /\bnon ho informazioni\b/i
  ];
  return !incompletePatterns.some((re) => re.test(lower));
}

export function hasProductContext(history: Array<{ role: string; content?: string | null }>): boolean {
  return history.some((msg) => {
    if (msg.role !== "assistant") return false;
    const content = msg.content || "";
    return PRODUCT_CONTEXT_PATTERNS.some((re) => re.test(content));
  });
}

export function hasClarifierBeenAsked(history: Array<{ role: string; content?: string | null }>): boolean {
  return history.some((msg) => {
    if (msg.role !== "assistant") return false;
    const content = msg.content || "";
    if (!content.includes("?")) return false;
    return CLARIFIER_PATTERNS.some((re) => re.test(content));
  });
}

export function shouldAskClarifyingQuestion(params: {
  message: string;
  history: Array<{ role: string; content?: string | null }>;
}): boolean {
  const { message, history } = params;
  if (!detectIndecision(message)) return false;
  if (hasClarifierBeenAsked(history)) return false;
  if (hasProductContext(history)) return false;
  return true;
}

export function isDirectQuestionIntent(classification: IntentClassification): boolean {
  return (
    classification.intent === "PRICE_ONLY" ||
    classification.intent === "SIZE_ONLY" ||
    classification.intent === "SHIPPING_INFO"
  );
}

export function shouldAllowOfferAfterAnswer(params: {
  intent: IntentClassification;
  assistantReply?: string;
  forceBlockOffer?: boolean;
  directQuestion?: boolean;
  supportBlockConfidence?: number;
  shoppingMinConfidence?: number;
}): boolean {
  const {
    intent,
    assistantReply,
    forceBlockOffer,
    directQuestion,
    supportBlockConfidence = 0.6,
    shoppingMinConfidence = 0.6
  } = params;

  if (forceBlockOffer) return false;
  if (intent.intent === "SUPPORT" && intent.confidence >= supportBlockConfidence) {
    return false;
  }

  const direct = typeof directQuestion === "boolean" ? directQuestion : isDirectQuestionIntent(intent);
  if (direct) {
    if (!assistantReply || !isAnswerComplete(assistantReply)) {
      return false;
    }
  }

  return intent.intent === "SHOPPING" && intent.confidence >= shoppingMinConfidence;
}
