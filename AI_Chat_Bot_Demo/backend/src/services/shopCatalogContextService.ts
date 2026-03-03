import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { getChatCompletion } from "../openai/client";
import { getShopByDomain } from "../shopify/shopService";

export type ShopCatalogContext = {
  shopDomain: string;
  updatedAt: string;
  summary: string;
  categories: string[];
  useCases: string[];
  audiences: string[];
  notableAttributes: string[];
  pricePositioning: "budget" | "mid" | "premium" | "mixed" | "unknown";
  priceRange?: { min?: number; max?: number; currency?: string | null };
  signals: {
    productTypes: string[];
    tags: string[];
    optionNames: string[];
  };
  sampleSize: number;
};

const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const contextCache = new Map<
  string,
  { context: ShopCatalogContext; expiresAt: number }
>();

const contextSchema = z.object({
  summary: z.string().min(1),
  categories: z.array(z.string()).default([]),
  useCases: z.array(z.string()).default([]),
  audiences: z.array(z.string()).default([]),
  notableAttributes: z.array(z.string()).default([]),
  pricePositioning: z
    .enum(["budget", "mid", "premium", "mixed", "unknown"])
    .default("unknown"),
  priceRange: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().nullable().optional()
    })
    .optional()
});

const selectionSchema = z.object({
  categories: z.array(z.string()).default([]),
  useCases: z.array(z.string()).default([]),
  audiences: z.array(z.string()).default([]),
  notableAttributes: z.array(z.string()).default([])
});

const contextUpdateSchema = contextSchema.partial();

type CatalogSnapshot = {
  stats: {
    productTypes: Array<{ name: string; count: number }>;
    tags: Array<{ name: string; count: number }>;
    optionNames: Array<{ name: string; count: number }>;
    priceRange?: { min?: number; max?: number; currency?: string | null };
  };
  products: Array<{
    title: string;
    productType: string | null;
    tags: string[];
    vendor: string | null;
    description: string | null;
    priceMin: number | null;
    priceMax: number | null;
    options: Array<{ name: string; values: string[] }>;
  }>;
};

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(input: string, max = 220): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1).trim()}…`;
}

function toTopList(counts: Map<string, number>, limit: number) {
  return Array.from(counts.entries())
    .filter(([name]) => name && name.trim())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function buildSnapshot(params: {
  products: Array<{
    id: string;
    title: string;
    productType: string | null;
    tags: string[];
    vendor: string | null;
    bodyHtml: string | null;
    priceMin: Prisma.Decimal | number | null;
    priceMax: Prisma.Decimal | number | null;
  }>;
  variants: Array<{ productDbId: string; selectedOptions: any }>;
}): CatalogSnapshot {
  const productTypes = new Map<string, number>();
  const tags = new Map<string, number>();
  const optionNames = new Map<string, number>();
  let priceMin: number | undefined;
  let priceMax: number | undefined;

  const variantsByProduct = new Map<string, Array<{ selectedOptions: any }>>();
  for (const variant of params.variants) {
    const list = variantsByProduct.get(variant.productDbId) || [];
    list.push({ selectedOptions: variant.selectedOptions });
    variantsByProduct.set(variant.productDbId, list);
  }

  const products = params.products.map((product) => {
    const priceMinValue =
      product.priceMin == null ? null : Number(product.priceMin);
    const priceMaxValue =
      product.priceMax == null ? null : Number(product.priceMax);
    if (product.productType) {
      const key = normalizeKey(product.productType);
      productTypes.set(key, (productTypes.get(key) || 0) + 1);
    }
    if (Array.isArray(product.tags)) {
      for (const tag of product.tags) {
        const key = normalizeKey(tag);
        if (!key) continue;
        tags.set(key, (tags.get(key) || 0) + 1);
      }
    }

    if (typeof priceMinValue === "number" && Number.isFinite(priceMinValue)) {
      priceMin = priceMin == null ? priceMinValue : Math.min(priceMin, priceMinValue);
    }
    if (typeof priceMaxValue === "number" && Number.isFinite(priceMaxValue)) {
      priceMax = priceMax == null ? priceMaxValue : Math.max(priceMax, priceMaxValue);
    }

    const optionValueMap = new Map<string, Set<string>>();
    const variantList = variantsByProduct.get(product.id) || [];
    for (const variant of variantList) {
      const options = Array.isArray(variant.selectedOptions)
        ? (variant.selectedOptions as Array<{ name?: string; value?: string }>)
        : [];
      for (const opt of options) {
        if (!opt?.name || !opt?.value) continue;
        const nameKey = normalizeKey(opt.name);
        if (!nameKey) continue;
        if (!optionValueMap.has(opt.name)) {
          optionValueMap.set(opt.name, new Set());
        }
        optionValueMap.get(opt.name)!.add(String(opt.value));
        optionNames.set(nameKey, (optionNames.get(nameKey) || 0) + 1);
      }
    }

    const options = Array.from(optionValueMap.entries()).map(([name, values]) => ({
      name,
      values: Array.from(values).slice(0, 6)
    }));

    return {
      title: product.title,
      productType: product.productType,
      tags: Array.isArray(product.tags) ? product.tags.slice(0, 8) : [],
      vendor: product.vendor,
      description: product.bodyHtml ? truncate(stripHtml(product.bodyHtml), 220) : null,
      priceMin: priceMinValue,
      priceMax: priceMaxValue,
      options
    };
  });

  return {
    stats: {
      productTypes: toTopList(productTypes, 12),
      tags: toTopList(tags, 12),
      optionNames: toTopList(optionNames, 12),
      priceRange:
        priceMin != null || priceMax != null
          ? { min: priceMin, max: priceMax, currency: null }
          : undefined
    },
    products
  };
}

function buildFallbackContext(params: {
  shopDomain: string;
  sampleSize: number;
  snapshot: CatalogSnapshot;
}): ShopCatalogContext {
  const { shopDomain, sampleSize, snapshot } = params;
  const topTypes = snapshot.stats.productTypes.map((t) => t.name);
  const topTags = snapshot.stats.tags.map((t) => t.name);
  const optionNames = snapshot.stats.optionNames.map((t) => t.name);

  const summaryParts: string[] = [];
  if (topTypes.length > 0) {
    summaryParts.push(`Catalog focuses on ${topTypes.slice(0, 3).join(", ")}.`);
  }
  if (topTags.length > 0) {
    summaryParts.push(`Common themes include ${topTags.slice(0, 3).join(", ")}.`);
  }
  if (optionNames.length > 0) {
    summaryParts.push(`Frequently configured attributes: ${optionNames.slice(0, 3).join(", ")}.`);
  }

  return {
    shopDomain,
    updatedAt: new Date().toISOString(),
    summary: summaryParts.join(" ") || "Catalog overview is limited by available data.",
    categories: topTypes.slice(0, 8),
    useCases: [],
    audiences: [],
    notableAttributes: optionNames.slice(0, 8),
    pricePositioning: "unknown",
    priceRange: snapshot.stats.priceRange,
    signals: {
      productTypes: topTypes.slice(0, 8),
      tags: topTags.slice(0, 8),
      optionNames: optionNames.slice(0, 8)
    },
    sampleSize
  };
}

async function summarizeWithLLM(params: {
  botId: string;
  snapshot: CatalogSnapshot;
}): Promise<z.infer<typeof contextSchema> | null> {
  const system = [
    "You analyze a Shopify catalog snapshot and produce a concise business context summary.",
    "Return ONLY strict JSON with keys:",
    '{"summary":"...", "categories":["..."], "useCases":["..."], "audiences":["..."], "notableAttributes":["..."], "pricePositioning":"budget|mid|premium|mixed|unknown", "priceRange":{"min":0,"max":0,"currency":"USD"}}',
    "Use only signals present in the snapshot. Do not invent brands or categories not supported by data.",
    "If uncertain, leave arrays empty and set pricePositioning to unknown.",
    "Summary must be 1-3 sentences."
  ].join(" ");

  try {
    const raw = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 1000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(params.snapshot) }
      ],
      usageContext: {
        botId: params.botId,
        operation: "shop_catalog_context"
      }
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn("[shop_catalog_context] JSON parse failed", {
        error: (err as Error)?.message || err,
        rawPreview: raw.slice(0, 800)
      });
      return null;
    }
    const result = contextSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[shop_catalog_context] schema validation failed", {
        issues: result.error.issues,
        parsedPreview: JSON.stringify(parsed).slice(0, 800)
      });
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export async function getShopCatalogContext(params: {
  botId: string;
  shopDomain: string;
}): Promise<ShopCatalogContext | null> {
  const cacheKey = `${params.botId}:${params.shopDomain}`;
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  const row = await prisma.shopCatalogContext.findUnique({
    where: {
      ShopCatalogContext_botId_shopDomain_unique: {
        botId: params.botId,
        shopDomain: params.shopDomain
      }
    }
  });
  if (!row) return null;

  const context = row.contextJson as ShopCatalogContext;
  contextCache.set(cacheKey, {
    context,
    expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS
  });
  return context;
}

export async function buildShopCatalogContext(
  botId: string,
  shopDomain: string,
  productSampleLimit = 200
): Promise<ShopCatalogContext> {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (shop.botId && shop.botId !== botId) {
    throw new Error("Shop is linked to a different bot");
  }

  const products = await prisma.shopifyProduct.findMany({
    where: { shopId: shop.id },
    orderBy: { updatedAt: "desc" },
    take: productSampleLimit,
    select: {
      id: true,
      title: true,
      productType: true,
      tags: true,
      vendor: true,
      bodyHtml: true,
      priceMin: true,
      priceMax: true
    }
  });

  const productIds = products.map((p) => p.id);
  const variants = productIds.length
    ? await prisma.shopifyVariant.findMany({
        where: { shopId: shop.id, productDbId: { in: productIds } },
        select: { productDbId: true, selectedOptions: true }
      })
    : [];

  const snapshot = buildSnapshot({ products, variants });
  const llmResult = await summarizeWithLLM({ botId, snapshot });

  const contextBase = llmResult
    ? {
        summary: llmResult.summary,
        categories: llmResult.categories || [],
        useCases: llmResult.useCases || [],
        audiences: llmResult.audiences || [],
        notableAttributes: llmResult.notableAttributes || [],
        pricePositioning: llmResult.pricePositioning || "unknown",
        priceRange: llmResult.priceRange
      }
    : buildFallbackContext({
        shopDomain,
        sampleSize: products.length,
        snapshot
      });

  const context: ShopCatalogContext = {
    shopDomain,
    updatedAt: new Date().toISOString(),
    summary: contextBase.summary,
    categories: contextBase.categories,
    useCases: contextBase.useCases,
    audiences: contextBase.audiences,
    notableAttributes: contextBase.notableAttributes,
    pricePositioning: contextBase.pricePositioning,
    priceRange: contextBase.priceRange ?? snapshot.stats.priceRange,
    signals: {
      productTypes: snapshot.stats.productTypes.map((t) => t.name),
      tags: snapshot.stats.tags.map((t) => t.name),
      optionNames: snapshot.stats.optionNames.map((t) => t.name)
    },
    sampleSize: products.length
  };

  if (context.priceRange && !context.priceRange.currency) {
    context.priceRange.currency = shop.shopCurrency ?? null;
  }

  await prisma.shopCatalogContext.upsert({
    where: {
      ShopCatalogContext_botId_shopDomain_unique: {
        botId,
        shopDomain
      }
    },
    update: {
      contextJson: context,
      updatedAt: new Date()
    },
    create: {
      id: crypto.randomUUID(),
      botId,
      shopDomain,
      contextJson: context
    }
  });

  const cacheKey = `${botId}:${shopDomain}`;
  contextCache.set(cacheKey, {
    context,
    expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS
  });

  return context;
}

export async function updateShopCatalogContext(params: {
  botId: string;
  shopDomain: string;
  patch: z.input<typeof contextUpdateSchema>;
}): Promise<ShopCatalogContext> {
  const parsed = contextUpdateSchema.safeParse(params.patch);
  if (!parsed.success) {
    throw new Error("Invalid catalog context payload");
  }

  const row = await prisma.shopCatalogContext.findUnique({
    where: {
      ShopCatalogContext_botId_shopDomain_unique: {
        botId: params.botId,
        shopDomain: params.shopDomain
      }
    }
  });
  if (!row) {
    throw new Error("Catalog context not found");
  }

  const current = row.contextJson as ShopCatalogContext;
  const next: ShopCatalogContext = {
    ...current,
    ...parsed.data,
    updatedAt: new Date().toISOString(),
    signals: current.signals,
    sampleSize: current.sampleSize
  };

  await prisma.shopCatalogContext.update({
    where: { id: row.id },
    data: {
      contextJson: next,
      updatedAt: new Date()
    }
  });

  const cacheKey = `${params.botId}:${params.shopDomain}`;
  contextCache.set(cacheKey, {
    context: next,
    expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS
  });

  return next;
}

function normalizeMessage(message: string): string {
  return message.trim();
}

function takeTopN(values: string[], limit: number): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, Math.max(0, limit));
}

export async function selectShopCatalogContextForMessage(params: {
  botId: string;
  context: ShopCatalogContext;
  message: string;
  limits?: {
    categories?: number;
    useCases?: number;
    audiences?: number;
    notableAttributes?: number;
  };
}): Promise<ShopCatalogContext> {
  const limits = {
    categories: params.limits?.categories ?? 8,
    useCases: params.limits?.useCases ?? 6,
    audiences: params.limits?.audiences ?? 5,
    notableAttributes: params.limits?.notableAttributes ?? 6
  };

  const message = normalizeMessage(params.message);
  if (!message) {
    return {
      ...params.context,
      categories: takeTopN(params.context.categories, limits.categories),
      useCases: takeTopN(params.context.useCases, limits.useCases),
      audiences: takeTopN(params.context.audiences, limits.audiences),
      notableAttributes: takeTopN(
        params.context.notableAttributes,
        limits.notableAttributes
      )
    };
  }

  const system = [
    "You select the most relevant items from each list based on the user message.",
    "Use ONLY the provided items. Do not add new items.",
    "Return strict JSON with keys: categories, useCases, audiences, notableAttributes.",
    "Each key must be an array of strings. Respect the provided limits.",
    "Output must be MINIFIED JSON (no newlines, no extra whitespace).",
    "If unsure, return empty arrays."
  ].join(" ");

  const payload = {
    message,
    limits,
    lists: {
      categories: params.context.categories,
      useCases: params.context.useCases,
      audiences: params.context.audiences,
      notableAttributes: params.context.notableAttributes
    }
  };

  try {
    const raw = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 180,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) }
      ],
      usageContext: {
        botId: params.botId,
        operation: "shop_catalog_context_select"
      }
    });

    const parsed = JSON.parse(raw);
    const result = selectionSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[shop_catalog_context_select] validation failed", {
        issues: result.error.issues
      });
      throw new Error("Invalid selection payload");
    }

    const selected = {
      ...params.context,
      categories: takeTopN(result.data.categories, limits.categories),
      useCases: takeTopN(result.data.useCases, limits.useCases),
      audiences: takeTopN(result.data.audiences, limits.audiences),
      notableAttributes: takeTopN(
        result.data.notableAttributes,
        limits.notableAttributes
      )
    };
    console.log("[shop_catalog_context_select] top_n", {
      botId: params.botId,
      categories: selected.categories,
      useCases: selected.useCases,
      audiences: selected.audiences,
      notableAttributes: selected.notableAttributes
    });
    return selected;
  } catch (err) {
    console.warn("[shop_catalog_context_select] fallback to top N", {
      error: (err as Error)?.message || err
    });
    const fallback = {
      ...params.context,
      categories: takeTopN(params.context.categories, limits.categories),
      useCases: takeTopN(params.context.useCases, limits.useCases),
      audiences: takeTopN(params.context.audiences, limits.audiences),
      notableAttributes: takeTopN(
        params.context.notableAttributes,
        limits.notableAttributes
      )
    };
    console.log("[shop_catalog_context_select] top_n", {
      botId: params.botId,
      categories: fallback.categories,
      useCases: fallback.useCases,
      audiences: fallback.audiences,
      notableAttributes: fallback.notableAttributes
    });
    return fallback;
  }
}
