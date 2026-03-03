import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { getChatCompletion } from "../openai/client";
import {
  ShopCatalogSchema,
  ShopCatalogAttribute,
  getShopCatalogSchema
} from "./catalogIntelligenceService";
import {
  getShopCatalogContext,
  selectShopCatalogContextForMessage
} from "./shopCatalogContextService";
import { toolGetProductDetails, toolAddToCart, toolGetCheckoutLink } from "../shopify/toolService";
import { searchShopifyProducts } from "../shopify/productService";
import { getShopForBotId } from "../shopify/shopService";

type Lang = "it" | "es" | "en" | "de" | "fr";

export type ClerkQuestion = {
  attrName: string;
  question: string;
  options?: string[];
  optionMap?: Record<string, string>;
};

export type ClerkShortlistItem = {
  productId: string;
  title: string;
  priceMin: string | null;
  priceMax: string | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  addToCartUrl: string | null;
  variantId: string | null;
  attrSummary: Array<{ label: string; value: string }>;
};

export type ClerkPayload =
  | { type: "shortlist"; items: ClerkShortlistItem[] }
  | { type: "details"; item: ClerkShortlistItem; checkoutUrl?: string | null };

export type ClerkResult = {
  reply: string;
  payload?: ClerkPayload;
  handled: boolean;
};

type ClerkState = {
  id: string;
  botId: string;
  shopDomain: string;
  sessionId: string | null;
  conversationId: string | null;
  language: Lang | null;
  awaitingBroaden: boolean;
  pendingQuestions: ClerkQuestion[];
  collectedFilters: Record<string, string>;
  lastShortlist: ClerkShortlistItem[];
  lastShortlistAt: string | null;
  selectedProductId: string | null;
  rejectedProductIds?: string[];
};

const QUESTION_LIMIT = 2;
const SHORTLIST_SIZE = 3;
const MAX_ATTR_CARDINALITY = 60;

const TRANSLATION_CACHE = new Map<string, string>();

const I18N = {
  en: {
    needMore: "To help you choose, I just need one quick detail:",
    chooseOne: "Which one interests you?",
    optionsIntro: "Here are {count} options:",
    noExactTagMatch: "I could not find matches with that tag. Here are similar options:",
    clarifySelection: "Do you mean option {a} or option {b}?",
    selectedIntro: "Here are the details for",
    questionTemplate: "What {attr} do you prefer?",
    questionWithExamples: "What {attr} do you prefer? For example: {examples}.",
    noResults: "I could not find matches for that. Want me to broaden the search?",
    catalogIntro: "We mainly sell:",
    catalogFollowup: "What kind of product are you interested in?"
  },
  it: {
    needMore: "Per aiutarti a scegliere, mi serve un dettaglio:",
    chooseOne: "Quale ti interessa?",
    optionsIntro: "Ecco {count} opzioni:",
    noExactTagMatch: "Non ho trovato risultati con quell'etichetta. Ecco opzioni simili:",
    clarifySelection: "Intendi l'opzione {a} o l'opzione {b}?",
    selectedIntro: "Ecco i dettagli per",
    questionTemplate: "Che {attr} preferisci?",
    questionWithExamples: "Che {attr} preferisci? Ad esempio: {examples}.",
    noResults: "Non ho trovato risultati per questo. Vuoi che allarghi la ricerca?",
    catalogIntro: "Vendiamo principalmente:",
    catalogFollowup: "Che tipo di prodotto ti interessa?"
  },
  es: {
    needMore: "Para ayudarte a elegir, necesito un detalle:",
    chooseOne: "¿Cuál te interesa?",
    optionsIntro: "Aqui tienes {count} opciones:",
    noExactTagMatch: "No encontre resultados con esa etiqueta. Aqui tienes opciones similares:",
    clarifySelection: "¿Te refieres a la opción {a} o la opción {b}?",
    selectedIntro: "Aqui estan los detalles de",
    questionTemplate: "¿Qué {attr} prefieres?",
    questionWithExamples: "¿Qué {attr} prefieres? Por ejemplo: {examples}.",
    noResults: "No encontré resultados con eso. ¿Quieres que amplíe la búsqueda?",
    catalogIntro: "Vendemos principalmente:",
    catalogFollowup: "¿Qué tipo de producto te interesa?",
  },
  de: {
    needMore: "Um dir bei der Auswahl zu helfen, brauche ich nur ein Detail:",
    chooseOne: "Welche Option interessiert dich?",
    optionsIntro: "Hier sind {count} Optionen:",
    noExactTagMatch:
      "Ich habe keine Treffer mit diesem Tag gefunden. Hier sind aehnliche Optionen:",
    clarifySelection: "Meinst du Option {a} oder Option {b}?",
    selectedIntro: "Hier sind die Details zu",
    questionTemplate: "Welche {attr} bevorzugst du?",
    questionWithExamples: "Welche {attr} bevorzugst du? Zum Beispiel: {examples}.",
    noResults: "Ich konnte dazu keine Treffer finden. Soll ich die Suche erweitern?",
    catalogIntro: "Wir verkaufen hauptsaechlich:",
    catalogFollowup: "Welche Art von Produkt interessiert dich?"
  },
  fr: {
    needMore: "Pour t'aider a choisir, j'ai besoin d'un detail :",
    chooseOne: "Laquelle t'interesse ?",
    optionsIntro: "Voici {count} options :",
    noExactTagMatch:
      "Je n'ai pas trouve de resultats avec cette etiquette. Voici des options similaires :",
    clarifySelection: "Tu parles de l'option {a} ou de l'option {b} ?",
    selectedIntro: "Voici les details pour",
    questionTemplate: "Quelle {attr} preferes-tu ?",
    questionWithExamples: "Quelle {attr} preferes-tu ? Par exemple : {examples}.",
    noResults: "Je n'ai pas trouve de resultats pour cela. Voulez-vous elargir la recherche ?",
    catalogIntro: "Nous vendons principalement :",
    catalogFollowup: "Quel type de produit t'interesse ?"
  }
} as const;

type LlmResolveResult = {
  language: Lang | null;
  query: string | null;
  attributes: Record<string, string>;
  broaden: "YES" | "NO" | "UNKNOWN";
};

function isNegativeFeedback(message: string): boolean {
  const lower = normalize(message);
  const signals: Record<Lang, string[]> = {
    en: ["dont like", "don't like", "not this", "none of these", "no thanks", "nope"],
    it: [
      "non mi piace",
      "non mi piacciono",
      "non va bene",
      "non queste",
      "nessuna",
      "no grazie",
      "non mi interessa",
      "non le voglio"
    ],
    es: ["no me gusta", "no me gustan", "no gracias", "ninguna", "no estas"],
    de: ["gefaellt mir nicht", "gefällt mir nicht", "mag ich nicht", "nicht das", "keine davon", "nein danke"],
    fr: ["je n'aime pas", "j'aime pas", "pas ca", "aucune", "non merci"]
  };
  return Object.values(signals)
    .flat()
    .some((s) => lower.includes(s));
}

function pickRefinementQuestionFromShortlist(
  lang: Lang,
  shortlist: ClerkShortlistItem[]
): ClerkQuestion | null {
  const valuesByLabel = new Map<string, Set<string>>();
  shortlist.forEach((item) => {
    item.attrSummary.forEach((pair) => {
      if (!valuesByLabel.has(pair.label)) {
        valuesByLabel.set(pair.label, new Set());
      }
      valuesByLabel.get(pair.label)!.add(pair.value);
    });
  });
  let bestLabel: string | null = null;
  let bestValues: string[] = [];
  let bestIsTag = false;
  for (const [label, values] of valuesByLabel.entries()) {
    const unique = Array.from(values);
    if (unique.length < 2 || unique.length > 6) continue;
    const isTag = normalize(label) === "tag";
    if (!bestLabel) {
      bestLabel = label;
      bestValues = unique;
      bestIsTag = isTag;
      continue;
    }
    if (bestIsTag && !isTag) {
      bestLabel = label;
      bestValues = unique;
      bestIsTag = isTag;
      continue;
    }
    if (bestIsTag === isTag && unique.length > bestValues.length) {
      bestLabel = label;
      bestValues = unique;
      bestIsTag = isTag;
    }
  }
  if (!bestLabel) return null;
  return {
    attrName: bestLabel,
    question: buildQuestionText(lang, bestLabel, bestValues.slice(0, 3)),
    options: bestValues.slice(0, 3)
  };
}

function pickSchemaHints(schema: ShopCatalogSchema) {
  const productTypes = schema.productTypes
    .map((t) => t.name)
    .filter(Boolean)
    .slice(0, 12);
  const attributes = schema.attributes
    .filter((a) => a.filterable && a.topValues.length > 0)
    .slice(0, 12)
    .map((a) => ({
      name: a.name,
      values: a.topValues.slice(0, 6)
    }));

  const typeAttributeValues: Record<string, Record<string, string[]>> = {};
  for (const typeName of productTypes) {
    const typeKey = normalize(typeName);
    const attrMap = schema.typeAttributeValues?.[typeKey];
    if (!attrMap) continue;
    const trimmed: Record<string, string[]> = {};
    Object.entries(attrMap)
      .slice(0, 6)
      .forEach(([attrName, values]) => {
        trimmed[attrName] = values.slice(0, 6);
      });
    if (Object.keys(trimmed).length > 0) {
      typeAttributeValues[typeName] = trimmed;
    }
  }

  return { productTypes, attributes, typeAttributeValues };
}

async function resolveWithLLM(params: {
  botId: string;
  message: string;
  schema: ShopCatalogSchema;
  awaitingBroaden: boolean;
}): Promise<LlmResolveResult | null> {
  const hints = pickSchemaHints(params.schema);
  const system = [
    "You help map a shopper message to catalog search terms.",
    "Return strict JSON with keys:",
    '{"language":"en|it|es|de|fr|null","query":"string|null","attributes":{"AttrName":"Value"},"broaden":"YES|NO|UNKNOWN"}',
    "Use ONLY the provided catalog terms for query/attributes if possible.",
    "If the user uses a different language, translate/synonym-map into the closest catalog terms.",
    "Attribute values MUST be chosen from the catalog values shown for that attribute; otherwise omit the attribute.",
    "If unsure, set query to null and attributes to {}.",
    "If the message has no language signal (only numbers or very short), set language to null.",
    "Detect language from the user message.",
    "If awaitingBroaden=true, set broaden to YES/NO/UNKNOWN based on the user's intent."
  ].join(" ");

  const userPayload = {
    awaitingBroaden: params.awaitingBroaden,
    message: params.message,
    catalog: hints
  };

  try {
    const raw = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 120,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPayload) }
      ],
      usageContext: {
        botId: params.botId,
        operation: "cil_resolve"
      }
    });
    const parsed = JSON.parse(raw);
    return {
      language: parsed.language ?? null,
      query: parsed.query ?? null,
      attributes: parsed.attributes ?? {},
      broaden: parsed.broaden ?? "UNKNOWN"
    };
  } catch {
    return null;
  }
}

export function detectLanguage(message: string, current?: Lang): Lang {
  const lower = message.trim().toLowerCase();
  if (!lower) return current || "en";
  const itSignals = ["ciao", "grazie", "vorrei", "carrello", "prezzo", "quanto costa"];
  const esSignals = ["hola", "gracias", "quiero", "carrito", "precio", "por favor"];
  const deSignals = ["hallo", "danke", "ich moechte", "ich möchte", "warenkorb", "preis", "bitte"];
  const frSignals = ["bonjour", "salut", "merci", "je veux", "panier", "prix", "s'il vous plait", "svp"];
  if (itSignals.some((s) => lower.includes(s))) return "it";
  if (esSignals.some((s) => lower.includes(s))) return "es";
  if (deSignals.some((s) => lower.includes(s))) return "de";
  if (frSignals.some((s) => lower.includes(s))) return "fr";
  return current || "en";
}

function hasLanguageSignal(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  // If message contains any letter, treat as a language signal.
  return /\p{L}/u.test(trimmed);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function translateStrings(
  lang: Lang,
  items: string[],
  botId: string
): Promise<string[]> {
  if (lang === "en") return items;
  const outputs: string[] = new Array(items.length);
  const missing: string[] = [];
  const missingIdx: number[] = [];

  items.forEach((item, idx) => {
    const key = `${lang}::${item}`;
    const cached = TRANSLATION_CACHE.get(key);
    if (cached) {
      outputs[idx] = cached;
    } else {
      missing.push(item);
      missingIdx.push(idx);
    }
  });

  if (missing.length === 0) return outputs;

  const system = [
    `Translate each item to ${lang}.`,
    "Keep brand names, numbers, sizes, and units unchanged.",
    "Return a strict JSON array of strings in the SAME order.",
    "Do not add or remove items."
  ].join(" ");

  try {
    const raw = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: Math.min(200, 30 + missing.length * 20),
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(missing) }
      ],
      usageContext: {
        botId,
        operation: "cil_translate"
      }
    });
    const translated = JSON.parse(raw);
    if (Array.isArray(translated) && translated.length === missing.length) {
      translated.forEach((value, i) => {
        const idx = missingIdx[i];
        const str = typeof value === "string" ? value : missing[i];
        outputs[idx] = str;
        TRANSLATION_CACHE.set(`${lang}::${missing[i]}`, str);
      });
      return outputs;
    }
  } catch {
    // fall through to default
  }

  missing.forEach((item, i) => {
    const idx = missingIdx[i];
    outputs[idx] = item;
  });
  return outputs;
}

function buildQuestionText(lang: Lang, label: string, examples: string[]): string {
  const template = examples.length
    ? I18N[lang].questionWithExamples
    : I18N[lang].questionTemplate;
  return template
    .replace("{attr}", label)
    .replace("{examples}", examples.join(", "));
}

function buildQuestion(
  lang: Lang,
  attr: ShopCatalogAttribute,
  overrideValues?: string[]
): ClerkQuestion {
  const examples = (overrideValues && overrideValues.length > 0
    ? overrideValues
    : attr.topValues
  ).slice(0, 3);
    const question = buildQuestionText(lang, attr.name, examples);
    return { attrName: attr.name, question, options: examples };
}

async function localizeQuestion(
  lang: Lang,
  question: ClerkQuestion,
  botId: string
): Promise<ClerkQuestion> {
  if (lang === "en") return question;
  const items = [question.attrName, ...(question.options || [])];
  const translated = await translateStrings(lang, items, botId);
  const label = translated[0] || question.attrName;
  const examples = translated.slice(1).filter(Boolean);
  const optionMap: Record<string, string> = {};
  (question.options || []).forEach((original, idx) => {
    const localized = translated[idx + 1] || original;
    optionMap[normalize(localized)] = original;
  });

  return {
    attrName: question.attrName,
    question: buildQuestionText(lang, label, examples),
    options: examples,
    optionMap
  };
}

async function localizeAttrSummary(
  lang: Lang,
  summary: Array<{ label: string; value: string }>,
  botId: string
): Promise<Array<{ label: string; value: string }>> {
  if (lang === "en") return summary;
  const flattened: string[] = [];
  summary.forEach((pair) => {
    flattened.push(pair.label, pair.value);
  });
  const translated = await translateStrings(lang, flattened, botId);
  const localized: Array<{ label: string; value: string }> = [];
  for (let i = 0; i < summary.length; i += 1) {
    const label = translated[i * 2] || summary[i].label;
    const value = translated[i * 2 + 1] || summary[i].value;
    localized.push({ label, value });
  }
  return localized;
}

export function extractProvidedAttributes(
  message: string,
  schema: ShopCatalogSchema,
  productTypeHint?: string | null,
  allowShortValues = false
): Record<string, string> {
  const lower = normalize(message);
  const result: Record<string, string> = {};
  const typeKey = productTypeHint ? normalize(productTypeHint) : null;
  const typeValues = typeKey ? schema.typeAttributeValues?.[typeKey] || null : null;
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);

  const hasToken = (value: string) => {
    const norm = normalize(value);
    if (!norm) return false;
    return tokens.includes(norm);
  };

  const hasPhrase = (value: string) => {
    const norm = normalize(value);
    if (!norm) return false;
    if (tokens.length === 0) return false;
    if (norm.length <= 2) {
      return allowShortValues && hasToken(value);
    }
    const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    return re.test(lower);
  };

  for (const attr of schema.attributes) {
    const candidates =
      typeValues && typeValues[attr.name]
        ? typeValues[attr.name]
        : attr.topValues;
    if (!candidates || candidates.length === 0) continue;
    for (const value of candidates) {
      if (hasPhrase(value)) {
        result[attr.name] = value;
        break;
      }
    }
  }
  return result;
}

function matchProductTypeHint(message: string, schema: ShopCatalogSchema): string | null {
  const lower = normalize(message);
  const types = schema.productTypes.map((t) => t.name).filter(Boolean);
  for (const type of types) {
    const norm = normalize(type);
    if (norm && lower.includes(norm)) return type;
  }
  const tagAttr = schema.attributes.find((a) => a.source === "tag");
  if (tagAttr) {
    for (const value of tagAttr.topValues) {
      const norm = normalize(value);
      if (norm && lower.includes(norm)) return value;
    }
  }
  return null;
}

function detectBroadRequest(
  message: string,
  schema: ShopCatalogSchema,
  collectedFilters: Record<string, string>
): boolean {
  const lower = normalize(message);
  const shoppingSignals = [
    "looking for",
    "need",
    "want",
    "vorrei",
    "voglio",
    "cerco",
    "sto cercando",
    "mi serve",
    "mi servono",
    "desidero",
    "quiero",
    "busco",
    "quisiera",
    "me gustaria",
    "ich suche",
    "ich brauche",
    "ich moechte",
    "suche",
    "brauche",
    "je cherche",
    "j'ai besoin",
    "je veux"
  ];
  const hasSignal = shoppingSignals.some((s) => lower.includes(s));
  const provided = Object.keys(collectedFilters).length > 0;
  if (provided) return false;
  if (hasSignal) return true;
  const typeHint = matchProductTypeHint(message, schema);
  return !!typeHint;
}

function isCatalogOverviewRequest(message: string, lang: Lang): boolean {
  const lower = normalize(message);
  const signals: Record<Lang, string[]> = {
    en: [
      "what do you sell",
      "what do you have",
      "what products",
      "show me your products",
      "catalog",
      "catalogue"
    ],
    it: [
      "cosa vendete",
      "che cosa vendete",
      "cosa avete",
      "che vendete",
      "dimmi cosa vendete",
      "catalogo",
      "prodotti"
    ],
    es: [
      "que venden",
      "que vendes",
      "que tienen",
      "que productos",
      "catalogo",
      "productos"
    ],
    de: [
      "was verkauft ihr",
      "was verkauft ihr?",
      "was habt ihr",
      "welche produkte",
      "katalog"
    ],
    fr: [
      "que vendez vous",
      "que vendez-vous",
      "quels produits",
      "catalogue",
      "catalogue produits"
    ]
  };
  return signals[lang].some((s) => lower.includes(s));
}

export function chooseQualificationQuestions(
  schema: ShopCatalogSchema,
  productTypeHint: string | null,
  collectedFilters: Record<string, string>,
  lang: Lang
): ClerkQuestion[] {
  const typeKey = productTypeHint ? normalize(productTypeHint) : null;
  const typeValues = typeKey ? schema.typeAttributeValues?.[typeKey] || null : null;
  const candidateNames =
    (productTypeHint && schema.typeToAttributes[normalize(productTypeHint)]) || [];

  const candidates = schema.attributes.filter((attr) => {
    if (!attr.filterable && attr.source !== "option") return false;
    if (collectedFilters[attr.name]) return false;
    if (attr.cardinality > MAX_ATTR_CARDINALITY) return false;
    if (attr.coverage < 0.2) return false;
    if (attr.source === "type") return false;
    if (attr.source === "tag") return false;
    if (typeValues && !typeValues[attr.name]) return false;
    return true;
  });

  const ranked = candidates.sort((a, b) => b.coverage - a.coverage);
  const chosen: ShopCatalogAttribute[] = [];

  if (candidateNames.length > 0) {
    for (const name of candidateNames) {
      const match = ranked.find(
        (attr) => normalize(attr.name) === normalize(name)
      );
      if (match && chosen.length < QUESTION_LIMIT) {
        chosen.push(match);
      }
    }
  }

  for (const attr of ranked) {
    if (chosen.length >= QUESTION_LIMIT) break;
    if (!chosen.includes(attr)) {
      chosen.push(attr);
    }
  }

  if (chosen.length === 0) {
    const fallback = schema.attributes
      .filter((attr) => {
        if (attr.source === "type" || attr.source === "tag") return false;
        if (collectedFilters[attr.name]) return false;
        return attr.topValues && attr.topValues.length > 0;
      })
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, QUESTION_LIMIT);
    return fallback.map((attr) =>
      buildQuestion(lang, attr, typeValues ? typeValues[attr.name] : undefined)
    );
  }

  return chosen
    .slice(0, QUESTION_LIMIT)
    .map((attr) =>
      buildQuestion(lang, attr, typeValues ? typeValues[attr.name] : undefined)
    );
}

export function parseSelectionIndex(message: string, lang: Lang, max: number): number | null {
  const lower = normalize(message);
  const numericMatch = lower.match(/\b([1-9])\b/);
  if (numericMatch) {
    const idx = Number(numericMatch[1]);
    if (idx >= 1 && idx <= max) return idx - 1;
  }
  const words: Record<Lang, Record<string, number>> = {
    en: { first: 0, second: 1, third: 2 },
    it: { primo: 0, prima: 0, secondo: 1, seconda: 1, terzo: 2, terza: 2 },
    es: { primero: 0, primera: 0, segundo: 1, segunda: 1, tercero: 2, tercera: 2 },
    de: {
      erste: 0,
      erster: 0,
      erstens: 0,
      zweite: 1,
      zweiter: 1,
      zweitens: 1,
      dritte: 2,
      dritter: 2,
      drittens: 2
    },
    fr: {
      premier: 0,
      premiere: 0,
      premierement: 0,
      deuxieme: 1,
      second: 1,
      seconde: 1,
      deuxiemement: 1,
      troisieme: 2,
      troisiemement: 2
    }
  };
  const map = words[lang] || {};
  for (const [word, idx] of Object.entries(map)) {
    if (lower.includes(word) && idx < max) return idx;
  }
  return null;
}

export function resolveSelectionByAttributes(
  message: string,
  items: ClerkShortlistItem[]
): ClerkShortlistItem[] {
  const lower = normalize(message);
  const matches: ClerkShortlistItem[] = [];

  for (const item of items) {
    const values = item.attrSummary.map((s) => normalize(s.value));
    if (values.some((value) => value && lower.includes(value))) {
      matches.push(item);
    }
  }
  return matches;
}

async function loadClerkState(params: {
  botId: string;
  shopDomain: string;
  sessionId: string | null;
  conversationId: string | null;
}): Promise<ClerkState> {
  const { botId, shopDomain, sessionId, conversationId } = params;
  let row = null;
  if (conversationId) {
    row = await prisma.shopifyClerkState.findUnique({
      where: {
        ShopifyClerkState_botId_conversationId_unique: {
          botId,
          conversationId
        }
      }
    });
  }
  if (!row && sessionId) {
    row = await prisma.shopifyClerkState.findUnique({
      where: {
        ShopifyClerkState_botId_sessionId_unique: {
          botId,
          sessionId
        }
      }
    });
  }

  if (!row) {
    return {
      id: crypto.randomUUID(),
      botId,
      shopDomain,
      sessionId,
      conversationId,
      language: null,
      awaitingBroaden: false,
      pendingQuestions: [],
      collectedFilters: {},
      lastShortlist: [],
      lastShortlistAt: null,
      selectedProductId: null,
      rejectedProductIds: []
    };
  }

    return {
      id: row.id,
      botId: row.botId,
      shopDomain: row.shopDomain,
      sessionId: row.sessionId ?? null,
      conversationId: row.conversationId ?? null,
      language: (row.language as Lang) || null,
      awaitingBroaden: row.awaitingBroaden ?? false,
      pendingQuestions: (row.pendingQuestions as ClerkQuestion[]) || [],
      collectedFilters: (row.collectedFilters as Record<string, string>) || {},
      lastShortlist: (row.lastShortlist as ClerkShortlistItem[]) || [],
      lastShortlistAt: row.lastShortlistAt ? row.lastShortlistAt.toISOString() : null,
      selectedProductId: row.selectedProductId ?? null,
      rejectedProductIds: (row.rejectedProductIds as string[]) || []
  };
}

async function saveClerkState(state: ClerkState): Promise<void> {
  const where = state.sessionId
    ? {
        ShopifyClerkState_botId_sessionId_unique: {
          botId: state.botId,
          sessionId: state.sessionId
        }
      }
    : state.conversationId
      ? {
          ShopifyClerkState_botId_conversationId_unique: {
            botId: state.botId,
            conversationId: state.conversationId
          }
        }
      : { id: state.id };

  await prisma.shopifyClerkState.upsert({
    where,
    update: {
      language: state.language,
      awaitingBroaden: state.awaitingBroaden,
      pendingQuestions: state.pendingQuestions,
      collectedFilters: state.collectedFilters,
      lastShortlist: state.lastShortlist,
      lastShortlistAt: state.lastShortlistAt ? new Date(state.lastShortlistAt) : null,
      selectedProductId: state.selectedProductId,
      rejectedProductIds: state.rejectedProductIds,
      updatedAt: new Date()
    },
    create: {
      id: state.id,
      botId: state.botId,
      shopDomain: state.shopDomain,
      sessionId: state.sessionId,
      conversationId: state.conversationId,
      language: state.language,
      awaitingBroaden: state.awaitingBroaden,
      pendingQuestions: state.pendingQuestions,
      collectedFilters: state.collectedFilters,
      lastShortlist: state.lastShortlist,
      lastShortlistAt: state.lastShortlistAt ? new Date(state.lastShortlistAt) : null,
      selectedProductId: state.selectedProductId,
      rejectedProductIds: state.rejectedProductIds
    }
  });
}

function buildShortlistReply(
  lang: Lang,
  items: ClerkShortlistItem[],
  relaxedTag = false
): string {
  const introBase = I18N[lang].optionsIntro.replace("{count}", String(items.length));
  const intro = relaxedTag ? I18N[lang].noExactTagMatch : introBase;
  const lines = items.map((item, idx) => {
    const price = item.priceMin || item.priceMax || "";
    const suffix = price ? ` — ${price}` : "";
    return `${idx + 1}. ${item.title}${suffix}`;
  });
  return [intro, ...lines, I18N[lang].chooseOne].join("\n");
}

function buildAttributeSummary(
  schema: ShopCatalogSchema,
  product: {
    productType?: string | null;
    tags?: string[];
    variants?: Array<{ selectedOptions?: any }>;
  }
): Array<{ label: string; value: string }> {
  const result: Array<{ label: string; value: string }> = [];
  const attrMap = new Map<string, string>();

  if (product.productType) {
    attrMap.set("Product type", product.productType);
  }
  if (Array.isArray(product.tags)) {
    const tag = product.tags[0];
    if (tag) {
      attrMap.set("Tag", tag);
    }
  }
  if (Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      const options = Array.isArray(variant.selectedOptions)
        ? (variant.selectedOptions as Array<{ name?: string; value?: string }>)
        : [];
      for (const opt of options) {
        if (!opt?.name || !opt?.value) continue;
        if (!attrMap.has(opt.name)) {
          attrMap.set(opt.name, opt.value);
        }
      }
    }
  }

  const allowedAttrs = new Set(
    schema.attributes
      .filter((attr) => attr.filterable)
      .map((attr) => normalize(attr.name))
  );

  for (const [label, value] of attrMap.entries()) {
    if (!allowedAttrs.has(normalize(label))) continue;
    result.push({ label, value });
    if (result.length >= 3) break;
  }

  return result;
}

function buildSearchQuery(
  productTypeHint: string | null,
  textFilterValues: string[],
  extraTokens: string[] = [],
  fallbackMessage?: string
): string {
  const parts: string[] = [];
  if (productTypeHint) parts.push(productTypeHint);
  for (const value of textFilterValues) {
    if (value && value.trim()) parts.push(value);
  }
  for (const token of extraTokens) {
    if (token && token.trim()) parts.push(token.trim());
  }
  if (parts.length === 0 && fallbackMessage) {
    parts.push(fallbackMessage);
  }
  return parts.join(" ").trim();
}

function findAttribute(schema: ShopCatalogSchema, name: string): ShopCatalogAttribute | null {
  const target = normalize(name);
  if (!target) return null;
  return (
    schema.attributes.find((attr) => normalize(attr.name) === target) || null
  );
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildStructuredFilters(
  schema: ShopCatalogSchema,
  collectedFilters: Record<string, string>,
  productTypeHint: string | null
) {
  const optionFilters: Array<{ name: string; value: string }> = [];
  const tagFilters: string[] = [];
  let productType: string | null = null;
  const textTokens: string[] = [];
  const textFilterValues: string[] = [];

  for (const [attrName, valueRaw] of Object.entries(collectedFilters)) {
    if (attrName.startsWith("__")) continue;
    const value = normalizeValue(valueRaw || "");
    if (!value) continue;
    const attr = findAttribute(schema, attrName);
    if (!attr) {
      textTokens.push(value);
      textFilterValues.push(value);
      continue;
    }

    if (attr.source === "option") {
      const normalized = normalizeValue(value).toLowerCase();
      const valid =
        attr.topValues?.some(
          (v) => normalizeValue(v).toLowerCase() === normalized
        ) ?? false;
      if (valid) {
        optionFilters.push({ name: attr.name, value });
      } else {
        textTokens.push(value);
        textFilterValues.push(value);
      }
      continue;
    }
    if (attr.source === "type") {
      productType = value;
      continue;
    }
    if (attr.source === "tag") {
      tagFilters.push(value);
      continue;
    }
    textTokens.push(value);
    textFilterValues.push(value);
  }

  if (!productType && productTypeHint) {
    productType = productTypeHint;
  }

  return { optionFilters, tagFilters, productType, textTokens, textFilterValues };
}

function extractMeasurementTokens(message: string): string[] {
  const tokens = new Set<string>();
  const re = /(\d+)\s*([a-zA-Z]{1,4})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    const num = match[1];
    const unit = match[2];
    if (!num || !unit) continue;
    const compact = `${num}${unit}`;
    const spaced = `${num} ${unit}`;
    tokens.add(compact);
    tokens.add(spaced);
  }
  return Array.from(tokens);
}

function extractMeasurementUnit(message: string): string | null {
  const re = /(\d+)\s*([a-zA-Z]{1,4})/g;
  const match = re.exec(message);
  return match?.[2] ? match[2].toLowerCase() : null;
}

function extractNumericTokensNoUnit(message: string): number[] {
  const tokens = new Set<number>();
  const re = /\b(\d+(?:[.,]\d+)?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    const num = Number(match[1].replace(",", "."));
    if (!Number.isFinite(num)) continue;
    tokens.add(num);
  }
  return Array.from(tokens);
}

function parseNumericUnit(value: string): { num: number; unit: string | null } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/(\d+(?:[.,]\d+)?)(?:\s*([a-zA-Z]{1,4}))?/);
  if (!match) return null;
  const num = Number(match[1].replace(",", "."));
  if (!Number.isFinite(num)) return null;
  const unit = match[2] ? match[2].toLowerCase() : null;
  return { num, unit };
}

function deriveMeasurementRange(
  schema: ShopCatalogSchema,
  productTypeHint: string | null,
  preferredUnit: string | null,
  attrName?: string | null
): { min: number; max: number; unit: string | null } | null {
  const typeKey = productTypeHint ? normalize(productTypeHint) : null;
  const typeValues = typeKey ? schema.typeAttributeValues?.[typeKey] || null : null;
  const candidates: Array<{ num: number; unit: string | null }> = [];

  const addValues = (values: string[]) => {
    for (const value of values) {
      const parsed = parseNumericUnit(value);
      if (!parsed) continue;
      candidates.push(parsed);
    }
  };

  if (attrName) {
    const attr = schema.attributes.find(
      (a) => normalize(a.name) === normalize(attrName)
    );
    if (typeValues && attr?.name && typeValues[attr.name]) {
      addValues(typeValues[attr.name]);
    } else if (attr?.topValues) {
      addValues(attr.topValues);
    }
  } else if (typeValues) {
    Object.values(typeValues).forEach((values) => addValues(values));
  } else {
    schema.attributes.forEach((attr) => addValues(attr.topValues));
  }

  if (candidates.length === 0) return null;

  const filtered =
    preferredUnit
      ? candidates.filter((c) => c.unit === preferredUnit)
      : candidates;
  const pool = filtered.length > 0 ? filtered : candidates;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const unitCounts = new Map<string | null, number>();
  pool.forEach((c) => {
    if (c.num < min) min = c.num;
    if (c.num > max) max = c.num;
    unitCounts.set(c.unit, (unitCounts.get(c.unit) || 0) + 1);
  });

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  let unit: string | null = null;
  let bestCount = 0;
  for (const [u, count] of unitCounts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      unit = u ?? null;
    }
  }

  return { min, max, unit };
}

function buildRangePrompt(
  lang: Lang,
  range: { min: number; max: number; unit: string | null }
): string {
  const unit = range.unit ? range.unit : "";
  const displayUnit = unit ? ` ${unit}` : "";
  const same = Math.round(range.min) === Math.round(range.max);
  if (lang === "it") {
    if (same) {
      return `Non ho trovato risultati per quella misura. La misura disponibile è circa ${range.min}${displayUnit}. Vuoi provare questa misura?`;
    }
    return `Non ho trovato risultati per quella misura. Le misure disponibili sono circa ${range.min}-${range.max}${displayUnit}. Vuoi provare una misura in questo intervallo?`;
  }
  if (lang === "es") {
    if (same) {
      return `No encontré resultados para esa medida. La medida disponible es aproximadamente ${range.min}${displayUnit}. ¿Quieres probar esa medida?`;
    }
    return `No encontré resultados para esa medida. Las medidas disponibles son aproximadamente ${range.min}-${range.max}${displayUnit}. ¿Quieres probar una medida en este rango?`;
  }
  if (lang === "de") {
    if (same) {
      return `Ich habe keine Ergebnisse fuer diese Groesse gefunden. Die verfuegbare Groesse ist etwa ${range.min}${displayUnit}. Moechtest du diese Groesse ausprobieren?`;
    }
    return `Ich habe keine Ergebnisse fuer diese Groesse gefunden. Verfuegbare Groessen sind etwa ${range.min}-${range.max}${displayUnit}. Moechtest du eine Groesse in diesem Bereich ausprobieren?`;
  }
  if (lang === "fr") {
    if (same) {
      return `Je n'ai pas trouve de resultats pour cette taille. La taille disponible est environ ${range.min}${displayUnit}. Voulez-vous essayer cette taille ?`;
    }
    return `Je n'ai pas trouve de resultats pour cette taille. Les tailles disponibles sont environ ${range.min}-${range.max}${displayUnit}. Voulez-vous essayer une taille dans cette plage ?`;
  }
  if (same) {
    return `I couldn't find results for that size. The available size is roughly ${range.min}${displayUnit}. Want to try that size?`;
  }
  return `I couldn't find results for that size. Available sizes are roughly ${range.min}-${range.max}${displayUnit}. Want to try a size in that range?`;
}

function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function isAffirmative(message: string): boolean {
  const normalized = stripDiacritics(message || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return (
    normalized === "si" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "ok" ||
    normalized === "okay" ||
    normalized === "va bene" ||
    normalized === "certo" ||
    normalized === "sure" ||
    normalized === "ja" ||
    normalized === "oui"
  );
}

export async function handleClerkFlow(params: {
  botId: string;
  shopDomain: string;
  message: string;
  sessionId: string | null;
  conversationId: string | null;
}): Promise<ClerkResult | null> {
  console.log("[clerk] enter", {
    botId: params.botId,
    shopDomain: params.shopDomain,
    message: params.message,
    sessionId: params.sessionId,
    conversationId: params.conversationId
  });
  const schema = await getShopCatalogSchema({
    botId: params.botId,
    shopDomain: params.shopDomain
  });
  if (!schema) return null;

  const state = await loadClerkState(params);
  let llmResolved: LlmResolveResult | null = null;

  const suggestedValue =
    (state.collectedFilters["__range_suggested_value"] as string | undefined) ||
    null;
  const suggestedAttr =
    (state.collectedFilters["__range_suggested_attr"] as string | undefined) ||
    (state.collectedFilters["__last_question_attr"] as string | undefined) ||
    null;
  if (
    state.collectedFilters["__range_prompted"] === "1" &&
    suggestedAttr &&
    suggestedValue &&
    isAffirmative(params.message)
  ) {
    state.collectedFilters[suggestedAttr] = suggestedValue;
    delete state.collectedFilters["__range_prompted"];
    delete state.collectedFilters["__range_suggested_value"];
    delete state.collectedFilters["__range_suggested_attr"];
    await saveClerkState(state);
  }

  llmResolved = await resolveWithLLM({
    botId: params.botId,
    message: params.message,
    schema,
    awaitingBroaden: state.awaitingBroaden
  });
  if (!state.language) {
    if (llmResolved?.language && hasLanguageSignal(params.message)) {
      const wordCount = params.message.trim().split(/\s+/).filter(Boolean).length;
      const tooShortToSwitch = wordCount <= 1 && params.message.trim().length <= 6;
      if (!tooShortToSwitch) {
        state.language = llmResolved.language;
      }
    }
    if (!state.language) {
      state.language = detectLanguage(params.message, state.language ?? undefined);
    }
  }
  const lang = (state.language ?? "en") as Lang;
  state.language = lang;

  const typeHintFromState =
    (state.collectedFilters["Product Type"] as string | undefined) || null;
  const prevProductType =
    (state.collectedFilters["Product Type"] as string | undefined) || null;

  const explicitTypeHint = matchProductTypeHint(params.message, schema);
  const wordCount = params.message.trim().split(/\s+/).filter(Boolean).length;
  const allowShortValues =
    state.pendingQuestions.length > 0 ||
    params.message.trim().length <= 3 ||
    wordCount <= 2;

  let newAttributes = extractProvidedAttributes(
    params.message,
    schema,
    typeHintFromState || explicitTypeHint,
    allowShortValues
  );
  if (llmResolved?.attributes && Object.keys(llmResolved.attributes).length > 0) {
    newAttributes = { ...newAttributes, ...llmResolved.attributes };
  }

  if (state.pendingQuestions.length > 0) {
    const next = state.pendingQuestions[0];
    const map = next.optionMap || {};
    const normalized = normalize(params.message);
    if (map[normalized]) {
      newAttributes = { ...newAttributes, [next.attrName]: map[normalized] };
    }
  }

  if (
    state.pendingQuestions.length > 0 &&
    !newAttributes[state.pendingQuestions[0].attrName] &&
    extractMeasurementTokens(params.message).length === 0 &&
    extractNumericTokensNoUnit(params.message).length > 0
  ) {
    const rangeAttr = state.pendingQuestions[0].attrName;
    if (state.collectedFilters["__range_prompted"] !== "1") {
      const range = deriveMeasurementRange(
        schema,
        (state.collectedFilters["Product Type"] as string | undefined) || null,
        null,
        rangeAttr
      );
      if (range) {
        state.collectedFilters["__range_prompted"] = "1";
        if (Math.round(range.min) === Math.round(range.max)) {
          const unit = range.unit ? range.unit : "";
          state.collectedFilters["__range_suggested_value"] = `${range.min}${unit}`;
          state.collectedFilters["__range_suggested_attr"] = rangeAttr;
        }
        await saveClerkState(state);
        return { handled: true, reply: buildRangePrompt(lang, range) };
      }
    }
  }

  const incomingType =
    newAttributes["Product Type"] || llmResolved?.attributes?.["Product Type"] || null;
  const nextType = incomingType || explicitTypeHint || null;
  const existingType = prevProductType;

  if (existingType && nextType && normalize(nextType) !== normalize(existingType)) {
    state.collectedFilters = { "Product Type": nextType };
    state.pendingQuestions = [];
    state.lastShortlist = [];
    state.lastShortlistAt = null;
    state.selectedProductId = null;
    state.rejectedProductIds = [];
    delete state.collectedFilters["__range_prompted"];
    delete state.collectedFilters["__last_question_attr"];
  } else {
    state.collectedFilters = { ...state.collectedFilters, ...newAttributes };
  }

  if (state.lastShortlist.length > 0 && isNegativeFeedback(params.message)) {
    const lastShortlistCopy = [...state.lastShortlist];
    state.rejectedProductIds = [
      ...(state.rejectedProductIds || []),
      ...lastShortlistCopy.map((item) => item.productId)
    ];
    state.lastShortlist = [];
    state.lastShortlistAt = null;
    state.selectedProductId = null;
    state.pendingQuestions = [];
    const refinement = pickRefinementQuestionFromShortlist(
      lang,
      lastShortlistCopy
    );
    if (refinement) {
      const localized = await localizeQuestion(lang, refinement, params.botId);
      state.pendingQuestions = [localized];
      state.collectedFilters["__last_question_attr"] = localized.attrName;
      await saveClerkState(state);
      const intro = I18N[lang].needMore;
      return { handled: true, reply: `${intro} ${localized.question}` };
    }
    const productTypeHint =
      (state.collectedFilters["Product Type"] as string | undefined) ||
      matchProductTypeHint(params.message, schema);
    const questions = chooseQualificationQuestions(
      schema,
      productTypeHint,
      state.collectedFilters,
      lang
    );
    if (questions.length > 0) {
      const localized = await Promise.all(
        questions.map((q) => localizeQuestion(lang, q, params.botId))
      );
      state.pendingQuestions = localized.slice(1);
      state.collectedFilters["__last_question_attr"] = localized[0].attrName;
      await saveClerkState(state);
      const intro = I18N[lang].needMore;
      return { handled: true, reply: `${intro} ${localized[0].question}` };
    }
  }
  if (state.awaitingBroaden) {
    const broaden = llmResolved?.broaden ?? "UNKNOWN";
    if (broaden === "NO") {
      state.awaitingBroaden = false;
      await saveClerkState(state);
      return {
        handled: true,
        reply:
          lang === "it"
            ? "Ok. Dimmi cosa vuoi cercare."
            : lang === "es"
              ? "De acuerdo. Dime qué quieres buscar."
              : lang === "de"
                ? "Okay. Sag mir, wonach du suchen moechtest."
                : lang === "fr"
                  ? "D'accord. Dis-moi ce que tu veux chercher."
                  : "Okay. Tell me what you want to search for."
      };
    }
    if (broaden === "YES") {
      state.awaitingBroaden = false;
    }
  }

  if (state.lastShortlist.length > 0) {
    const idx = parseSelectionIndex(
      params.message,
      lang,
      state.lastShortlist.length
    );
    if (idx != null) {
      const selected = state.lastShortlist[idx];
      state.selectedProductId = selected.productId;
      await saveClerkState(state);
      const checkout = await toolGetCheckoutLink({ botId: params.botId });
      return {
        handled: true,
        reply: `${I18N[lang].selectedIntro} ${selected.title}.`,
        payload: {
          type: "details",
          item: selected,
          checkoutUrl: checkout?.cartUrl || null
        }
      };
    }

    const matches = resolveSelectionByAttributes(
      params.message,
      state.lastShortlist
    );
    if (matches.length === 1) {
      const selected = matches[0];
      state.selectedProductId = selected.productId;
      await saveClerkState(state);
      const checkout = await toolGetCheckoutLink({ botId: params.botId });
      return {
        handled: true,
        reply: `${I18N[lang].selectedIntro} ${selected.title}.`,
        payload: {
          type: "details",
          item: selected,
          checkoutUrl: checkout?.cartUrl || null
        }
      };
    }
    if (matches.length > 1) {
      const indices = matches.map((item) =>
        state.lastShortlist.findIndex((i) => i.productId === item.productId) + 1
      );
      const reply = I18N[lang]
        .clarifySelection.replace("{a}", String(indices[0]))
        .replace("{b}", String(indices[1]));
      return { handled: true, reply };
    }
  }

  if (state.pendingQuestions.length > 0) {
    while (
      state.pendingQuestions.length > 0 &&
      state.collectedFilters[state.pendingQuestions[0].attrName]
    ) {
      state.pendingQuestions.shift();
    }
    const next = state.pendingQuestions[0];
    if (next) {
      state.collectedFilters["__last_question_attr"] = next.attrName;
      await saveClerkState(state);
      return { handled: true, reply: next.question };
    }
  }

  const productTypeHint =
    (state.collectedFilters["Product Type"] as string | undefined) ||
    matchProductTypeHint(params.message, schema);
  const isBroad = detectBroadRequest(params.message, schema, state.collectedFilters);
  const hasTypeOnly =
    !!productTypeHint ||
    Object.keys(state.collectedFilters).some(
      (key) => normalize(key) === "product type"
    );

  const meaningfulFilters = Object.keys(state.collectedFilters).filter((key) => {
    if (key.startsWith("__")) return false;
    const norm = normalize(key);
    return norm !== "product type" && norm !== "tag";
  }).length;

  const shop = await getShopForBotId(params.botId);
  if (!shop) return null;

  const fallbackMessage =
    llmResolved?.query || (isBroad ? params.message : undefined);
  let structured = buildStructuredFilters(
    schema,
    state.collectedFilters,
    productTypeHint
  );
  const measurementTokens = extractMeasurementTokens(params.message);
  const preferredUnit = extractMeasurementUnit(params.message);
  const numericNoUnitTokens = extractNumericTokensNoUnit(params.message);
  const requestedAttr =
    state.pendingQuestions[0]?.attrName ||
    state.collectedFilters["__last_question_attr"] ||
    null;
  if (measurementTokens.length > 0 && requestedAttr) {
    structured = {
      ...structured,
      optionFilters: structured.optionFilters.filter(
        (opt) => normalize(opt.name) === normalize(requestedAttr)
      )
    };
  }
  const spacedTokens = measurementTokens.filter((t) => t.includes(" "));
  const compactTokens = measurementTokens.filter((t) => !t.includes(" "));
  const measurementTokenPool =
    spacedTokens.length > 0 && compactTokens.length > 0
      ? [...spacedTokens, ...compactTokens]
      : spacedTokens.length > 0
        ? spacedTokens
        : compactTokens;
  const primaryTokens = Array.from(
    new Set([...(structured.textTokens || []), ...measurementTokenPool])
  );
  const secondaryTokens: string[] = [];

  const buildQueryForTokens = (tokens: string[]) =>
    buildSearchQuery(
      structured.productType,
      structured.textFilterValues,
      llmResolved?.query ? [llmResolved.query, ...tokens] : tokens,
      fallbackMessage
    );

  const query = buildQueryForTokens(primaryTokens);

  const runSearch = async (params: {
    queryOverride?: string;
    tagFilters?: string[];
    optionFilters?: Array<{ name: string; value: string }>;
  }) =>
    searchShopifyProducts(shop.shopDomain, {
      query: params.queryOverride ?? query,
      limit: 20,
      status: "ACTIVE",
      productType: structured.productType ?? undefined,
      tagFilters: params.tagFilters,
      optionFilters: params.optionFilters
    });

  let searchResult: Awaited<ReturnType<typeof searchShopifyProducts>> | null = null;

  if ((isBroad || hasTypeOnly) && meaningfulFilters === 0) {
    const rangeAttrCandidate =
      state.pendingQuestions[0]?.attrName ||
      state.collectedFilters["__last_question_attr"] ||
      null;
    if (
      (measurementTokens.length > 0 || numericNoUnitTokens.length > 0) &&
      rangeAttrCandidate
    ) {
      const hasRangePrompted = state.collectedFilters["__range_prompted"] === "1";
      if (!hasRangePrompted) {
        const rangeAttr = rangeAttrCandidate;
        const range = deriveMeasurementRange(
          schema,
          productTypeHint,
          measurementTokens.length > 0 ? preferredUnit : null,
          rangeAttr
        );
        if (range) {
          state.collectedFilters["__range_prompted"] = "1";
          if (Math.round(range.min) === Math.round(range.max)) {
            const unit = range.unit ? range.unit : "";
            state.collectedFilters["__range_suggested_value"] = `${range.min}${unit}`;
            state.collectedFilters["__range_suggested_attr"] = rangeAttr;
          }
          await saveClerkState(state);
          return { handled: true, reply: buildRangePrompt(lang, range) };
        }
      } else {
        const broadenQuery = buildQueryForTokens(structured.textTokens || []);
        const broadenResult = await runSearch({
          queryOverride: broadenQuery,
          tagFilters: undefined,
          optionFilters: undefined
        });
        if (broadenResult.items && broadenResult.items.length > 0) {
          delete state.collectedFilters["__range_prompted"];
          searchResult = broadenResult;
          state.awaitingBroaden = false;
          const rejected = new Set(state.rejectedProductIds || []);
          const items = broadenResult.items
            .filter((item) => !rejected.has(item.productId))
            .slice(0, SHORTLIST_SIZE);
          const shortlist: ClerkShortlistItem[] = [];
          for (const item of items) {
            const variant = await prisma.shopifyVariant.findFirst({
              where: { shopId: shop.id, productDbId: item.id, availableForSale: true },
              orderBy: [{ inventoryQuantity: "desc" }, { updatedAt: "desc" }]
            });

            let addToCart = null;
            if (variant) {
              try {
                addToCart = await toolAddToCart({
                  botId: params.botId,
                  sessionId: params.sessionId || `web:${params.conversationId || ""}`,
                  variantId: variant.variantId,
                  quantity: 1
                });
              } catch {
                addToCart = null;
              }
            }

            let details = null;
            try {
              details = await toolGetProductDetails({
                botId: params.botId,
                productId: item.productId
              });
            } catch {
              details = null;
            }

            const rawSummary = buildAttributeSummary(schema, {
              productType: item.productType,
              tags: item.tags,
              variants: details?.variants || []
            });
            const attrSummary = await localizeAttrSummary(
              lang,
              rawSummary,
              params.botId
            );

            shortlist.push({
              productId: item.productId,
              title: item.title,
              priceMin: item.priceMin?.toString() ?? null,
              priceMax: item.priceMax?.toString() ?? null,
              currency: shop.shopCurrency ?? null,
              imageUrl: item.imageUrl ?? null,
              productUrl: item.handle
                ? `https://${shop.shopDomain}/products/${item.handle}`
                : null,
              addToCartUrl: addToCart?.addToCartUrl || null,
              variantId: variant?.variantId || null,
              attrSummary
            });
          }

          state.lastShortlist = shortlist;
          state.lastShortlistAt = new Date().toISOString();
          await saveClerkState(state);
          return {
            handled: true,
            reply: buildShortlistReply(lang, shortlist),
            payload: { type: "shortlist", items: shortlist }
          };
        }
      }
    }
    const questions = chooseQualificationQuestions(
      schema,
      productTypeHint,
      state.collectedFilters,
      lang
    );
    console.log("[clerk] qualification", {
      isBroad,
      hasTypeOnly,
      meaningfulFilters,
      productTypeHint,
      questionsCount: questions.length
    });
      if (questions.length > 0) {
        const localized = await Promise.all(
          questions.map((q) => localizeQuestion(lang, q, params.botId))
        );
        state.pendingQuestions = localized.slice(1);
        if (localized[0]?.attrName) {
          state.collectedFilters["__last_question_attr"] = localized[0].attrName;
        }
        await saveClerkState(state);
        const intro = I18N[lang].needMore;
        return {
          handled: true,
          reply: `${intro} ${localized[0].question}`
      };
    }
  }

  if (!query.trim()) {
    if (isCatalogOverviewRequest(params.message, lang)) {
      const shopContext =
        params.botId && params.shopDomain
          ? await getShopCatalogContext({
              botId: params.botId,
              shopDomain: params.shopDomain
            })
          : null;
      if (shopContext) {
        const selected = await selectShopCatalogContextForMessage({
          botId: params.botId,
          context: shopContext,
          message: params.message
        });
        let summary = selected.summary || "";
        let categories = selected.categories || [];
        if (lang !== "en") {
          const translated = await translateStrings(
            lang,
            [summary, ...categories],
            params.botId
          );
          summary = translated[0] || summary;
          categories = translated.slice(1).filter(Boolean);
        }
        const intro = I18N[lang].catalogIntro || I18N.en.catalogIntro;
        const followup =
          I18N[lang].catalogFollowup || I18N.en.catalogFollowup;
        const categoryText =
          categories.length > 0 ? ` ${categories.join(", ")}.` : "";
        const summaryText = summary ? ` ${summary}` : "";
        return {
          handled: true,
          reply: `${intro}${categoryText}${summaryText} ${followup}`
        };
      }
    }
    return {
      handled: true,
      reply:
        lang === "it"
          ? "Certo. Dimmi cosa stai cercando."
          : lang === "es"
            ? "Claro. Dime qué estás buscando."
            : lang === "de"
              ? "Klar. Sag mir, wonach du suchst."
              : lang === "fr"
                ? "Bien sur. Dis-moi ce que tu cherches."
                : "Sure. Tell me what you're looking for."
    };
  }

  console.log("[clerk] filters", {
    botId: params.botId,
    sessionId: params.sessionId,
    productType: structured.productType,
    tagFilters: structured.tagFilters,
    optionFilters: structured.optionFilters,
    textTokens: primaryTokens,
    query
  });

  searchResult = await runSearch({
    tagFilters: structured.tagFilters.length > 0 ? structured.tagFilters : undefined,
    optionFilters: structured.optionFilters.length > 0 ? structured.optionFilters : undefined
  });
  let relaxedOptionFilters = false;
  let relaxedTagFilters = false;
  let usedSecondaryTokens = false;

  if (!searchResult.items || searchResult.items.length === 0) {
    if (structured.optionFilters.length > 0) {
      relaxedOptionFilters = true;
      searchResult = await runSearch({
        tagFilters: structured.tagFilters.length > 0 ? structured.tagFilters : undefined
      });
    }
  }

  if (
    (!searchResult.items || searchResult.items.length === 0) &&
    secondaryTokens.length > 0
  ) {
    usedSecondaryTokens = true;
    searchResult = await runSearch({
      queryOverride: buildQueryForTokens(secondaryTokens),
      tagFilters: structured.tagFilters.length > 0 ? structured.tagFilters : undefined,
      optionFilters: relaxedOptionFilters
        ? undefined
        : structured.optionFilters.length > 0
          ? structured.optionFilters
          : undefined
    });
  }

  if (
    (!searchResult.items || searchResult.items.length === 0) &&
    structured.tagFilters.length > 0
  ) {
    relaxedTagFilters = true;
    searchResult = await runSearch({
      queryOverride: usedSecondaryTokens ? buildQueryForTokens(secondaryTokens) : undefined,
      tagFilters: undefined,
      optionFilters: relaxedOptionFilters
        ? undefined
        : structured.optionFilters.length > 0
          ? structured.optionFilters
          : undefined
    });
    if (searchResult.items && searchResult.items.length > 0) {
      delete state.collectedFilters["Tag"];
    }
  }

  if (!searchResult.items || searchResult.items.length === 0) {
    if (measurementTokens.length > 0 || numericNoUnitTokens.length > 0) {
      const hasRangePrompted = state.collectedFilters["__range_prompted"] === "1";
      if (!hasRangePrompted) {
        const rangeAttr =
          state.pendingQuestions[0]?.attrName ||
          state.collectedFilters["__last_question_attr"] ||
          null;
        const range = deriveMeasurementRange(
          schema,
          structured.productType,
          measurementTokens.length > 0 ? preferredUnit : null,
          rangeAttr
        );
        if (range) {
          state.collectedFilters["__range_prompted"] = "1";
          if (Math.round(range.min) === Math.round(range.max)) {
            const unit = range.unit ? range.unit : "";
            state.collectedFilters["__range_suggested_value"] = `${range.min}${unit}`;
            if (rangeAttr) {
              state.collectedFilters["__range_suggested_attr"] = rangeAttr;
            }
          }
          await saveClerkState(state);
          return { handled: true, reply: buildRangePrompt(lang, range) };
        }
      } else {
        const broadenQuery = buildQueryForTokens(structured.textTokens || []);
        const broadenResult = await runSearch({
          queryOverride: broadenQuery,
          tagFilters: undefined,
          optionFilters: undefined
        });
        if (broadenResult.items && broadenResult.items.length > 0) {
          searchResult = broadenResult;
          delete state.collectedFilters["__range_prompted"];
        }
      }
    }
  }

  if (!searchResult.items || searchResult.items.length === 0) {
    const sample = await prisma.shopifyVariant.findFirst({
      where: { shopId: shop.id },
      select: { selectedOptions: true, productDbId: true }
    });
    if (sample?.selectedOptions) {
      console.log("[clerk] no_results_sample_options", {
        botId: params.botId,
        productDbId: sample.productDbId,
        selectedOptions: sample.selectedOptions
      });
    }
    state.awaitingBroaden = true;
    await saveClerkState(state);
    return { handled: true, reply: I18N[lang].noResults };
  }

  state.awaitingBroaden = false;
  delete state.collectedFilters["__range_prompted"];
  delete state.collectedFilters["__last_question_attr"];
  const rejected = new Set(state.rejectedProductIds || []);
  const items = searchResult.items
    .filter((item) => !rejected.has(item.productId))
    .slice(0, SHORTLIST_SIZE);
  const shortlist: ClerkShortlistItem[] = [];
  for (const item of items) {
    const variant = await prisma.shopifyVariant.findFirst({
      where: { shopId: shop.id, productDbId: item.id, availableForSale: true },
      orderBy: [{ inventoryQuantity: "desc" }, { updatedAt: "desc" }]
    });

    let addToCart = null;
    if (variant) {
      try {
        addToCart = await toolAddToCart({
          botId: params.botId,
          sessionId: params.sessionId || `web:${params.conversationId || ""}`,
          variantId: variant.variantId,
          quantity: 1
        });
      } catch {
        addToCart = null;
      }
    }

    let details = null;
    try {
      details = await toolGetProductDetails({
        botId: params.botId,
        productId: item.productId
      });
    } catch {
      details = null;
    }

    const rawSummary = buildAttributeSummary(schema, {
      productType: item.productType,
      tags: item.tags,
      variants: details?.variants || []
    });
    const attrSummary = await localizeAttrSummary(
      lang,
      rawSummary,
      params.botId
    );

      shortlist.push({
        productId: item.productId,
        title: item.title,
        priceMin: item.priceMin?.toString() ?? null,
        priceMax: item.priceMax?.toString() ?? null,
        currency: shop.shopCurrency ?? null,
      imageUrl: item.imageUrl ?? null,
      productUrl: item.handle
        ? `https://${shop.shopDomain}/products/${item.handle}`
        : null,
      addToCartUrl: addToCart?.addToCartUrl || null,
      variantId: variant?.variantId || null,
      attrSummary
    });
  }

  state.lastShortlist = shortlist;
  state.lastShortlistAt = new Date().toISOString();
  await saveClerkState(state);

  return {
    handled: true,
    reply: buildShortlistReply(lang, shortlist),
    payload: { type: "shortlist", items: shortlist }
  };
}

