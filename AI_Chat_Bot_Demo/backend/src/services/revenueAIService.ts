import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { getShopForBotId } from "../shopify/shopService";
import { buildCartUrl, toCartVariantId } from "../shopify/cartService";
import { DemoBotConfig } from "../bots/config";
import {
  IntentClassification,
  classifyIntent,
  detectIndecision,
  isDirectQuestionIntent,
  shouldAllowOfferAfterAnswer
} from "./revenueAIIntent";
import {
  CandidateProduct,
  ComplementMap,
  PerformanceStats,
  rankCandidates,
  isVariantAvailable,
  filterExcludedCandidates
} from "./revenueAIRecommender";

export type RevenueAIStyle = "SOFT" | "CLOSER";
export type RevenueAIMode = "AUTO" | "SOFT" | "CLOSER";
export type RevenueAIStage = "EXPLORATION" | "EVALUATION" | "CART" | "CHECKOUT";
export type RevenueAIOfferType = "UPSELL" | "CROSS_SELL" | "NEXT_BEST";

export type RevenueAISuggestion = {
  eventId: string;
  offerType: RevenueAIOfferType;
  stage: RevenueAIStage;
  style: RevenueAIStyle;
  reason: string;
  botId?: string;
  conversationId?: string;
  product: {
    productId: string;
    variantId: string | null;
    title: string;
    imageUrl: string | null;
    price: string | null;
    compareAtPrice: string | null;
    currency: string | null;
    productUrl: string | null;
    addToCartUrl: string | null;
    checkoutUrl: string | null;
  };
  cta: {
    addToCart: string;
    checkout: string;
  };
};

type RevenueAIOfferResult = {
  suggestion: RevenueAISuggestion;
  appendText?: string;
};

type MaybeOfferParams = {
  botConfig: DemoBotConfig;
  conversationId?: string;
  sessionId?: string;
  userMessage: string;
  assistantReply?: string;
  channel?: "WEB" | "WHATSAPP" | "FACEBOOK" | "INSTAGRAM";
  hasShopifyActionsInReply?: boolean;
  intentResult?: IntentClassification;
  forceBlockOffer?: boolean;
  indecisionSignal?: boolean;
};

type ShopifyEventRow = {
  event_type: string;
  created_at: Date;
  product_id: string | null;
  variant_id: string | null;
  session_id: string | null;
};

type CommerceContext = {
  events: ShopifyEventRow[];
  baseProduct: { product: any; variant: any } | null;
  messageIndex: number | null;
};

const COMMERCE_CACHE_TTL_MS = 90 * 1000;
const commerceContextCache = new Map<
  string,
  { expiresAt: number; value: CommerceContext }
>();

type PendingOfferEvent = {
  eventId: string;
  botId: string;
  conversationId: string;
  sessionId: string | null;
  offerType: RevenueAIOfferType;
  stage: RevenueAIStage;
  suggestedProductId: string;
  baseProductId: string | null;
  styleUsed: RevenueAIStyle;
  meta: any | null;
  createdAt: number;
};

const PENDING_OFFER_TTL_MS = 5 * 60 * 1000;
const pendingOfferEvents = new Map<string, PendingOfferEvent>();

function cacheKeyForContext(botId: string, conversationId: string): string {
  return `${botId}:${conversationId}`;
}

function pruneCommerceCache() {
  const now = Date.now();
  for (const [key, entry] of commerceContextCache.entries()) {
    if (entry.expiresAt <= now) commerceContextCache.delete(key);
  }
}

function prunePendingOffers() {
  const now = Date.now();
  for (const [key, entry] of pendingOfferEvents.entries()) {
    if (entry.createdAt + PENDING_OFFER_TTL_MS <= now) {
      pendingOfferEvents.delete(key);
    }
  }
}

export function getPendingOfferEvent(eventId: string): PendingOfferEvent | null {
  prunePendingOffers();
  return pendingOfferEvents.get(eventId) || null;
}

function trackPendingOfferEvent(entry: PendingOfferEvent) {
  prunePendingOffers();
  pendingOfferEvents.set(entry.eventId, entry);
}

const SUPPORT_BLOCK_CONFIDENCE = 0.6;
const SHOPPING_MIN_CONFIDENCE = 0.6;

export function computeAssignedStyle(seed: string): RevenueAIStyle {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  const last = digest[digest.length - 1];
  const value = parseInt(last, 16);
  return value % 2 === 0 ? "SOFT" : "CLOSER";
}

export function computeStyleUsed(params: {
  mode: RevenueAIMode;
  assignedStyle: RevenueAIStyle;
  overrideStyle: RevenueAIStyle | null;
}): RevenueAIStyle {
  const { mode, assignedStyle, overrideStyle } = params;
  if (mode === "SOFT") return "SOFT";
  if (mode === "CLOSER") return "CLOSER";
  return overrideStyle || assignedStyle;
}

async function fetchActiveStyleOverride(params: {
  botId: string;
  conversationId?: string;
  sessionId?: string;
}): Promise<{
  styleOverride: RevenueAIStyle;
  expiresAt: Date | null;
} | null> {
  const { botId, conversationId, sessionId } = params;
  const now = new Date();

  if (sessionId) {
    const override = await prisma.revenueAIStyleOverride.findFirst({
      where: {
        botId,
        sessionId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      orderBy: { updatedAt: "desc" }
    });
    if (override?.styleOverride) {
      return {
        styleOverride: override.styleOverride as RevenueAIStyle,
        expiresAt: override.expiresAt ?? null
      };
    }
  }

  if (conversationId) {
    const override = await prisma.revenueAIStyleOverride.findFirst({
      where: {
        botId,
        conversationId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      orderBy: { updatedAt: "desc" }
    });
    if (override?.styleOverride) {
      return {
        styleOverride: override.styleOverride as RevenueAIStyle,
        expiresAt: override.expiresAt ?? null
      };
    }
  }

  return null;
}

function normalizeVariantGid(variantId: string): string {
  if (variantId.startsWith("gid://")) return variantId;
  return `gid://shopify/ProductVariant/${variantId}`;
}

function normalizeProductGid(productId: string): string {
  if (productId.startsWith("gid://")) return productId;
  return `gid://shopify/Product/${productId}`;
}

async function fetchRecentShopifyEvents(
  botId: string,
  conversationId?: string
): Promise<ShopifyEventRow[]> {
  if (!conversationId) return [];
  return (await prisma.$queryRaw`
    SELECT event_type, created_at, product_id, variant_id, session_id
    FROM shopify_analytics_event
    WHERE bot_id = ${botId}
      AND conversation_id = ${conversationId}
    ORDER BY created_at DESC
    LIMIT 10
  `) as ShopifyEventRow[];
}

async function getCommerceContext(params: {
  botId: string;
  shopId: string;
  conversationId: string;
}): Promise<CommerceContext> {
  const { botId, shopId, conversationId } = params;
  pruneCommerceCache();
  const key = cacheKeyForContext(botId, conversationId);
  const cached = commerceContextCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const events = await fetchRecentShopifyEvents(botId, conversationId);
  const base = await resolveBaseProduct({ shopId, events });
  const messageIndex = await getMessageIndex(conversationId);

  const value: CommerceContext = {
    events,
    baseProduct: base,
    messageIndex
  };

  commerceContextCache.set(key, {
    expiresAt: Date.now() + COMMERCE_CACHE_TTL_MS,
    value
  });

  return value;
}

async function resolveBaseProduct(params: {
  shopId: string;
  events: ShopifyEventRow[];
}) {
  const { shopId, events } = params;
  const addEvent = events.find((e) => e.event_type === "add_to_cart");
  const viewEvent = events.find((e) => e.event_type === "view_product");

  const event = addEvent || viewEvent;
  if (!event) return null;

  if (event.variant_id) {
    const variant = await prisma.shopifyVariant.findFirst({
      where: {
        shopId,
        variantId: normalizeVariantGid(event.variant_id)
      },
      include: { product: true }
    });
    if (variant?.product) return { product: variant.product, variant };
  }

  if (event.product_id) {
    const raw = event.product_id;
    const byGid = await prisma.shopifyProduct.findFirst({
      where: { shopId, productId: normalizeProductGid(raw) }
    });
    if (byGid) return { product: byGid, variant: null };

    const byHandle = await prisma.shopifyProduct.findFirst({
      where: { shopId, handle: raw }
    });
    if (byHandle) return { product: byHandle, variant: null };
  }

  return null;
}

async function pickVariantForProduct(shopId: string, productDbId: string) {
  return prisma.shopifyVariant.findFirst({
    where: { shopId, productDbId, availableForSale: true },
    orderBy: [{ inventoryQuantity: "desc" }, { updatedAt: "desc" }]
  });
}

type CandidateQueryMode = "UPSELL" | "CROSS_SELL" | "NEXT_BEST";

function normalizeComplementMap(raw: any): ComplementMap | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as ComplementMap;
}

function parseComplementTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeTags(tags: string[] | null | undefined): string[] {
  if (!tags) return [];
  return tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
}

async function fetchCandidateProducts(params: {
  shopId: string;
  mode: CandidateQueryMode;
  baseProduct?: { id: string; productType?: string | null; vendor?: string | null; tags?: string[] | null; priceMin?: any } | null;
  excludeProductDbIds: string[];
  complementMap?: ComplementMap | null;
  upsellMinPct: number;
  upsellMaxPct: number;
}): Promise<CandidateProduct[]> {
  const { shopId, mode, baseProduct, excludeProductDbIds, complementMap, upsellMinPct, upsellMaxPct } = params;
  const baseTags = normalizeTags(baseProduct?.tags ?? []);
  const complement = normalizeComplementMap(complementMap);
  const complementTags = new Set<string>();
  const complementTypes = new Set<string>();
  const complementVendors = new Set<string>();

  if (baseProduct?.productType && complement?.productType?.[baseProduct.productType.toLowerCase()]) {
    complement.productType[baseProduct.productType.toLowerCase()].forEach((t) => complementTypes.add(t.toLowerCase()));
  }
  if (baseProduct?.vendor && complement?.vendor?.[baseProduct.vendor.toLowerCase()]) {
    complement.vendor[baseProduct.vendor.toLowerCase()].forEach((v) => complementVendors.add(v.toLowerCase()));
  }
  baseTags.forEach((tag) => {
    const mapped = complement?.tags?.[tag];
    if (mapped) mapped.forEach((t) => complementTags.add(t.toLowerCase()));
  });

  const basePrice =
    baseProduct?.priceMin != null
      ? Number(baseProduct.priceMin)
      : null;

  const minUpsell = basePrice ? basePrice * (1 + upsellMinPct / 100) : null;
  const maxUpsell = basePrice ? basePrice * (1 + upsellMaxPct / 100) : null;

  const where: any = {
    shopId,
    status: "ACTIVE",
    id: {
      notIn: excludeProductDbIds
    }
  };
  if (baseProduct?.id) {
    where.id.not = baseProduct.id;
  }

  if (mode === "UPSELL" && minUpsell && maxUpsell) {
    where.priceMin = { gte: minUpsell, lte: maxUpsell };
  }

  const or: any[] = [];
  if (baseProduct?.productType) {
    or.push({ productType: baseProduct.productType });
  }
  if (baseProduct?.vendor) {
    or.push({ vendor: baseProduct.vendor });
  }
  if (baseTags.length > 0) {
    or.push({ tags: { hasSome: baseTags } });
  }
  if (complementTags.size > 0) {
    or.push({ tags: { hasSome: Array.from(complementTags) } });
  }
  if (complementTypes.size > 0) {
    or.push({ productType: { in: Array.from(complementTypes) } });
  }
  if (complementVendors.size > 0) {
    or.push({ vendor: { in: Array.from(complementVendors) } });
  }

  if (or.length > 0 && mode !== "NEXT_BEST") {
    where.OR = or;
  }

  const products = await prisma.shopifyProduct.findMany({
    where,
    include: {
      variants: {
        where: { availableForSale: true },
        orderBy: [{ inventoryQuantity: "desc" }, { updatedAt: "desc" }]
      }
    },
    take: 60,
    orderBy: [{ updatedAt: "desc" }]
  });

  const candidates: CandidateProduct[] = [];
  for (const product of products) {
    const variant = product.variants.find((v) => isVariantAvailable(v));
    if (!variant) continue;
    candidates.push({
      id: product.id,
      productId: product.productId,
      handle: product.handle,
      title: product.title,
      productType: product.productType,
      vendor: product.vendor,
      tags: normalizeTags(product.tags),
      priceMin: product.priceMin != null ? Number(product.priceMin) : null,
      variant: {
        variantId: variant.variantId,
        price: variant.price != null ? Number(variant.price) : null,
        compareAtPrice: variant.compareAtPrice != null ? Number(variant.compareAtPrice) : null,
        availableForSale: variant.availableForSale,
        inventoryQuantity: variant.inventoryQuantity,
        imageUrl: variant.imageUrl || product.imageUrl || null
      }
    });
  }

  return candidates;
}

async function fetchPerformanceMap(params: {
  botId: string;
  productIds: string[];
  since: Date;
}): Promise<Map<string, PerformanceStats>> {
  const { botId, productIds, since } = params;
  if (productIds.length === 0) return new Map();

  const events = (await prisma.$queryRaw`
    SELECT "suggestedProductId" as product_id, COUNT(*)::int as impressions
    FROM "RevenueAIOfferEvent"
    WHERE "botId" = ${botId}
      AND "timestamp" >= ${since}
      AND "suggestedProductId" = ANY(${productIds})
    GROUP BY "suggestedProductId"
  `) as Array<{ product_id: string; impressions: number }>;

  const actions = (await prisma.$queryRaw`
    SELECT e."suggestedProductId" as product_id, a."action" as action, COUNT(*)::int as count
    FROM "RevenueAIOfferAction" a
    JOIN "RevenueAIOfferEvent" e ON e.id = a."eventId"
    WHERE a."botId" = ${botId}
      AND a."timestamp" >= ${since}
      AND e."suggestedProductId" = ANY(${productIds})
    GROUP BY e."suggestedProductId", a."action"
  `) as Array<{ product_id: string; action: string; count: number }>;

  const map = new Map<string, PerformanceStats>();
  events.forEach((row) => {
    map.set(row.product_id, {
      impressions: row.impressions,
      clicks: 0,
      addToCart: 0
    });
  });
  actions.forEach((row) => {
    const entry = map.get(row.product_id) || { impressions: 0, clicks: 0, addToCart: 0 };
    if (row.action === "CLICK") entry.clicks += row.count;
    if (row.action === "ADD_TO_CART") entry.addToCart += row.count;
    map.set(row.product_id, entry);
  });
  return map;
}

function resolveStage(params: {
  events: ShopifyEventRow[];
  userMessage: string;
}): RevenueAIStage {
  const { events, userMessage } = params;
  const latest = events[0];
  if (latest?.event_type === "add_to_cart") return "CART";
  if (latest?.event_type === "checkout_initiated") return "CHECKOUT";
  if (latest?.event_type === "view_product") {
    return detectIndecision(userMessage) ? "EVALUATION" : "EXPLORATION";
  }
  return detectIndecision(userMessage) ? "EVALUATION" : "EXPLORATION";
}

function buildOfferCopy(params: {
  style: RevenueAIStyle;
  stage: RevenueAIStage;
  productTitle: string;
}): string {
  const { style, stage, productTitle } = params;
  if (style === "CLOSER") {
    if (stage === "CHECKOUT" || stage === "CART") {
      return `Quick add before checkout: ${productTitle}.`;
    }
    return `Best pick to move forward: ${productTitle}.`;
  }

  if (stage === "CHECKOUT" || stage === "CART") {
    return `If you'd like a perfect add-on, ${productTitle} pairs well.`;
  }
  return `If you're comparing options, ${productTitle} is a great fit.`;
}

async function getMessageIndex(conversationId?: string): Promise<number | null> {
  if (!conversationId) return null;
  const count = await prisma.message.count({ where: { conversationId } });
  return count + 1;
}

export async function maybeBuildRevenueAIOffer(
  params: MaybeOfferParams
): Promise<RevenueAIOfferResult | null> {
  const {
    botConfig,
    conversationId,
    sessionId,
    userMessage,
    assistantReply,
    channel,
    hasShopifyActionsInReply,
    intentResult,
    forceBlockOffer,
    indecisionSignal
  } = params;

  const debugEnabled =
    String(process.env.REVENUE_AI_DEBUG || "").toLowerCase() === "true";
  const logSkip = (reason: string, extra?: Record<string, any>) => {
    if (!debugEnabled) return;
    console.log("[RevenueAI] skip", {
      reason,
      botId: botConfig.botId,
      conversationId,
      sessionId,
      ...extra
    });
  };

  if (!botConfig.botId) {
    logSkip("missing_bot_id");
    return null;
  }
  if (!botConfig.revenueAIEnabled) {
    logSkip("disabled");
    return null;
  }
  if (!conversationId) {
    logSkip("missing_conversation_id");
    return null;
  }
  const intent = intentResult ?? classifyIntent(userMessage);
  const directQuestion = isDirectQuestionIntent(intent);

  if (hasShopifyActionsInReply) {
    logSkip("transactional_shopify_reply");
    return null;
  }

  const allowOffer = shouldAllowOfferAfterAnswer({
    intent,
    assistantReply,
    forceBlockOffer,
    directQuestion,
    supportBlockConfidence: botConfig.revenueAIGuardrailsEnabled
      ? SUPPORT_BLOCK_CONFIDENCE
      : 1,
    shoppingMinConfidence: SHOPPING_MIN_CONFIDENCE
  });

  if (!allowOffer) {
    logSkip("intent_guardrail_block", {
      intent: intent.intent,
      confidence: intent.confidence,
      directQuestion
    });
    return null;
  }

  const shop = await getShopForBotId(botConfig.botId);
  if (!shop || !shop.isActive) {
    logSkip("shop_missing_or_inactive", {
      shopFound: !!shop,
      shopActive: shop?.isActive ?? null
    });
    return null;
  }

  const commerce = await getCommerceContext({
    botId: botConfig.botId,
    shopId: shop.id,
    conversationId
  });
  const events = commerce.events;
  const stage = resolveStage({ events, userMessage });

  if (stage === "EXPLORATION" && !detectIndecision(userMessage) && !indecisionSignal) {
    logSkip("exploration_without_indecision", {
      eventCount: events.length,
      lastEventType: events[0]?.event_type ?? null,
      indecisionSignal: !!indecisionSignal
    });
    return null;
  }

  const session = conversationId
    ? await prisma.revenueAISession.findUnique({
        where: { conversationId }
      })
    : null;

  const now = new Date();
  const messageIndex = commerce.messageIndex;

  const offerEveryX = botConfig.revenueAIOfferEveryXMessages ?? 6;
  const maxOffers = botConfig.revenueAIMaxOffersPerSession ?? 2;
  const cooldownMinutes = botConfig.revenueAICooldownMinutes ?? 15;
  const dedupeHours = botConfig.revenueAIDedupeHours ?? 24;

  if (session) {
    if (session.offersShownCount >= maxOffers) return null;
    if (session.lastOfferAt) {
      const diffMs = now.getTime() - session.lastOfferAt.getTime();
      if (diffMs < cooldownMinutes * 60 * 1000) return null;
    }
    if (
      messageIndex != null &&
      session.lastOfferMessageIndex != null &&
      messageIndex - session.lastOfferMessageIndex < offerEveryX
    ) {
      return null;
    }
  }

  const base = commerce.baseProduct;
  const baseProduct = base?.product ?? null;
  const basePrice =
    base?.variant?.price != null ? Number(base.variant.price) : baseProduct?.priceMin ? Number(baseProduct.priceMin) : null;

  const upsellMinPct = botConfig.revenueAIUpsellDeltaMinPct ?? 10;
  const upsellMaxPct = botConfig.revenueAIUpsellDeltaMaxPct ?? 35;
  const maxRecommendations = Math.min(Math.max(botConfig.revenueAIMaxRecommendations ?? 3, 1), 5);
  const aggressiveness = botConfig.revenueAIAggressiveness ?? 0.5;
  const complementMap = botConfig.revenueAICategoryComplementMap ?? null;

  const excludeDbIds = Array.isArray(session?.lastSuggestedProductIds)
    ? session!.lastSuggestedProductIds
    : [];

  const excludeShopifyIds = new Set<string>();
  const excludeHandles = new Set<string>();
  const excludeVariantIds = new Set<string>();
  events.forEach((e) => {
    if (e.event_type === "add_to_cart" || e.event_type === "purchase") {
      if (e.product_id) {
        if (e.product_id.startsWith("gid://")) excludeShopifyIds.add(e.product_id);
        else excludeHandles.add(e.product_id.toLowerCase());
      }
      if (e.variant_id) excludeVariantIds.add(e.variant_id);
    }
  });

  let offerType: RevenueAIOfferType = "NEXT_BEST";
  let candidates: CandidateProduct[] = [];

  const recMode: "UPSELL" | "CROSS_SELL" | "NEXT_BEST" =
    stage === "CART" || stage === "CHECKOUT"
      ? "CROSS_SELL"
      : stage === "EVALUATION"
      ? "UPSELL"
      : "NEXT_BEST";

  offerType = recMode === "UPSELL" ? "UPSELL" : recMode === "CROSS_SELL" ? "CROSS_SELL" : "NEXT_BEST";

  candidates = await fetchCandidateProducts({
    shopId: shop.id,
    mode: recMode,
    baseProduct: baseProduct
      ? {
          id: baseProduct.id,
          productType: baseProduct.productType,
          vendor: baseProduct.vendor,
          tags: baseProduct.tags ?? [],
          priceMin: baseProduct.priceMin ?? null
        }
      : null,
    excludeProductDbIds: excludeDbIds,
    complementMap,
    upsellMinPct,
    upsellMaxPct
  });

  if (candidates.length < 20 && recMode !== "NEXT_BEST") {
    const fallback = await fetchCandidateProducts({
      shopId: shop.id,
      mode: "NEXT_BEST",
      baseProduct: baseProduct
        ? {
            id: baseProduct.id,
            productType: baseProduct.productType,
            vendor: baseProduct.vendor,
            tags: baseProduct.tags ?? [],
            priceMin: baseProduct.priceMin ?? null
          }
        : null,
      excludeProductDbIds: excludeDbIds,
      complementMap,
      upsellMinPct,
      upsellMaxPct
    });
    candidates = [...candidates, ...fallback];
  }

  candidates = filterExcludedCandidates({
    candidates,
    excludeProductIds: excludeShopifyIds,
    excludeHandles,
    excludeVariantIds
  });

  if (candidates.length === 0) {
    logSkip("no_candidates_after_filters");
    return null;
  }

  const performanceSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const performanceMap = await fetchPerformanceMap({
    botId: botConfig.botId,
    productIds: candidates.map((c) => c.productId),
    since: performanceSince
  });

  const ranked = rankCandidates({
    candidates,
    base: {
      productType: baseProduct?.productType ?? null,
      vendor: baseProduct?.vendor ?? null,
      tags: baseProduct?.tags ?? [],
      price: basePrice ?? null
    },
    performanceMap,
    config: {
      upsellDeltaMinPct: upsellMinPct,
      upsellDeltaMaxPct: upsellMaxPct,
      aggressiveness,
      maxRecommendations,
      complementMap
    },
    forUpsell: offerType === "UPSELL"
  });

  const best = ranked[0];
  if (!best) {
    logSkip("no_ranked_candidate");
    return null;
  }

  const targetProduct = await prisma.shopifyProduct.findFirst({
    where: { id: best.id }
  });
  if (!targetProduct) {
    logSkip("target_product_missing");
    return null;
  }

  if (session?.lastSuggestedProductIds?.includes(targetProduct.id)) {
    if (session.lastSuggestedAt) {
      const diffMs = now.getTime() - session.lastSuggestedAt.getTime();
      if (diffMs < dedupeHours * 60 * 60 * 1000) return null;
    }
  }

  const variant = await pickVariantForProduct(shop.id, targetProduct.id);
  if (!variant) {
    logSkip("variant_missing");
    return null;
  }

  const assignedStyle = session?.assignedStyle
    ? (session.assignedStyle as RevenueAIStyle)
    : computeAssignedStyle(
        conversationId || botConfig.botId || targetProduct.id
      );

  const styleMode = (botConfig.revenueAIMode || "AUTO") as RevenueAIMode;
  const activeOverride = botConfig.botId
    ? await fetchActiveStyleOverride({
        botId: botConfig.botId,
        conversationId,
        sessionId
      })
    : null;
  const styleOverride =
    activeOverride?.styleOverride ??
    (session?.styleOverride as RevenueAIStyle | null);

  const styleUsed = computeStyleUsed({
    mode: styleMode,
    assignedStyle,
    overrideStyle: styleOverride
  });

  const cartUrls = await buildCartUrl({ shopDomain: shop.shopDomain });
  const addToCartUrl = variant
    ? `https://${shop.shopDomain}/cart/add?id=${encodeURIComponent(
        toCartVariantId(variant.variantId)
      )}&quantity=1`
    : null;

  const price =
    variant.price != null ? String(variant.price) : targetProduct.priceMin != null ? String(targetProduct.priceMin) : null;
  const compareAt =
    variant.compareAtPrice != null ? String(variant.compareAtPrice) : null;

  const eventId = crypto.randomUUID();
  const reason = buildOfferCopy({
    style: styleUsed,
    stage,
    productTitle: targetProduct.title
  });

  const suggestion: RevenueAISuggestion = {
    eventId,
    offerType,
    stage,
    style: styleUsed,
    reason,
    botId: botConfig.botId,
    conversationId,
    product: {
      productId: targetProduct.productId,
      variantId: variant.variantId,
      title: targetProduct.title,
      imageUrl: targetProduct.imageUrl || variant.imageUrl || null,
      price,
      compareAtPrice: compareAt,
      currency: shop.shopCurrency || null,
      productUrl: targetProduct.handle
        ? `https://${shop.shopDomain}/products/${targetProduct.handle}`
        : null,
      addToCartUrl,
      checkoutUrl: cartUrls.cartUrl
    },
    cta: {
      addToCart: styleUsed === "CLOSER" ? "Add to cart" : "Add to cart",
      checkout: styleUsed === "CLOSER" ? "View product" : "View product"
    }
  };

  const sessionRecordId = session?.id ?? null;

  trackPendingOfferEvent({
    eventId,
    botId: botConfig.botId!,
    conversationId,
    sessionId: sessionRecordId,
    offerType,
    stage,
    suggestedProductId: targetProduct.productId,
    baseProductId: baseProduct?.productId ?? null,
    styleUsed,
    meta: {
      shopDomain: shop.shopDomain,
      channel: channel || null
    },
    createdAt: Date.now()
  });

  // Non-blocking persistence (fail-open)
  void (async () => {
    try {
      if (conversationId) {
        if (!session) {
          await prisma.revenueAISession.create({
            data: {
              id: crypto.randomUUID(),
              botId: botConfig.botId!,
              conversationId,
              assignedStyle: assignedStyle,
              styleOverride: styleOverride ?? null,
              offersShownCount: 1,
              lastOfferMessageIndex: messageIndex ?? null,
              lastOfferAt: now,
              lastSuggestedProductIds: [targetProduct.id],
              lastSuggestedAt: now
            }
          });
        } else {
          const nextIds = Array.isArray(session.lastSuggestedProductIds)
            ? [...session.lastSuggestedProductIds]
            : [];
          if (!nextIds.includes(targetProduct.id)) nextIds.push(targetProduct.id);
          const trimmedIds = nextIds.slice(-10);
          await prisma.revenueAISession.update({
            where: { id: session.id },
            data: {
              offersShownCount: { increment: 1 },
              lastOfferMessageIndex: messageIndex ?? session.lastOfferMessageIndex,
              lastOfferAt: now,
              lastSuggestedProductIds: trimmedIds,
              lastSuggestedAt: now
            }
          });
        }
      }

      await prisma.revenueAIOfferEvent.create({
        data: {
          id: eventId,
          botId: botConfig.botId!,
          conversationId: conversationId,
          messageId: null,
          sessionId: sessionRecordId,
          offerType,
          stage,
          suggestedProductId: targetProduct.productId,
          baseProductId: baseProduct?.productId ?? null,
          styleUsed,
          meta: {
            shopDomain: shop.shopDomain,
            channel: channel || null
          },
          timestamp: now
        }
      });
    } catch (err) {
      console.error("Revenue AI persist offer failed", {
        botId: botConfig.botId,
        conversationId,
        eventId,
        error: err
      });
    } finally {
      pendingOfferEvents.delete(eventId);
    }
  })();

  const appendText =
    channel && channel !== "WEB"
      ? `${reason} ${suggestion.cta.addToCart} or ${suggestion.cta.checkout}.`
      : undefined;

  return { suggestion, appendText };
}

export async function trackRevenueAIAction(params: {
  eventId: string;
  botId: string;
  conversationId: string;
  action: "CLICK" | "ADD_TO_CART" | "CHECKOUT" | "PURCHASE";
  orderId?: string | null;
  revenueCents?: number | null;
  currency?: string | null;
  meta?: any;
  idempotencyKey: string;
}) {
  const inserted = await prisma.$executeRaw`
    INSERT INTO "RevenueAIOfferAction"
      ("id", "eventId", "botId", "conversationId", "action", "orderId", "revenueCents", "currency", "meta", "timestamp", "idempotencyKey")
    VALUES
      (${crypto.randomUUID()}, ${params.eventId}, ${params.botId}, ${params.conversationId}, ${params.action},
       ${params.orderId ?? null}, ${params.revenueCents ?? null}, ${params.currency ?? null}, ${params.meta ?? null},
       ${new Date()}, ${params.idempotencyKey})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;

  return { deduped: inserted === 0 };
}
