import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { getShopByDomain } from "../shopify/shopService";

export type ShopCatalogAttribute = {
  name: string;
  source: "option" | "metafield" | "tag" | "type" | "text";
  coverage: number;
  cardinality: number;
  topValues: string[];
  filterable: boolean;
};

export type ShopCatalogSchema = {
  shopDomain: string;
  updatedAt: string;
  productTypes: Array<{ name: string; count: number }>;
  attributes: ShopCatalogAttribute[];
  typeToAttributes: Record<string, string[]>;
  typeAttributeValues: Record<string, Record<string, string[]>>;
};

const SCHEMA_CACHE_TTL_MS = 2 * 60 * 1000;
const schemaCache = new Map<
  string,
  { schema: ShopCatalogSchema; expiresAt: number }
>();

const UNIT_PATTERN =
  "(mm|cm|m|in|inch|inches|ft|kg|g|lb|oz|l|ml)";

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toDisplayName(value: string): string {
  if (!value) return value;
  return value
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTextAttributes(text: string): Array<{ name: string; value: string }> {
  const results: Array<{ name: string; value: string }> = [];
  if (!text) return results;

  const keyValueRegex = new RegExp(
    `([A-Za-z][A-Za-z\\s]{2,30})\\s*[:\\-]\\s*(\\d+(?:[.,]\\d+)?\\s?${UNIT_PATTERN})`,
    "gi"
  );
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = keyValueRegex.exec(text)) !== null) {
    const rawKey = match[1];
    const rawValue = match[2];
    const key = normalizeKey(rawKey);
    const value = normalizeValue(rawValue);
    if (!key || !value) continue;
    const dedupeKey = `${key}::${value.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push({ name: key, value });
  }

  if (results.length === 0) {
    const measurementRegex = new RegExp(
      `\\b\\d+(?:[.,]\\d+)?\\s?${UNIT_PATTERN}\\b`,
      "gi"
    );
    const matches = text.match(measurementRegex) || [];
    const uniq = Array.from(new Set(matches.map((m) => normalizeValue(m))));
    uniq.slice(0, 5).forEach((value) => {
      results.push({ name: "measurement", value });
    });
  }

  return results;
}

function isFilterableAttribute(attr: ShopCatalogAttribute): boolean {
  if (!attr.topValues || attr.topValues.length === 0) return false;
  return true;
}

export async function getShopCatalogSchema(params: {
  botId: string;
  shopDomain: string;
}): Promise<ShopCatalogSchema | null> {
  const cacheKey = `${params.botId}:${params.shopDomain}`;
  const cached = schemaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.schema;
  }

  const row = await prisma.shopCatalogSchema.findUnique({
    where: {
      ShopCatalogSchema_botId_shopDomain_unique: {
        botId: params.botId,
        shopDomain: params.shopDomain
      }
    }
  });
  if (!row) return null;

  const schema = row.schemaJson as ShopCatalogSchema;
  schemaCache.set(cacheKey, {
    schema,
    expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS
  });
  return schema;
}

export function buildSchemaFromProducts(params: {
  shopDomain: string;
  products: Array<{
    id: string;
    productType: string | null;
    tags: string[];
    bodyHtml: string | null;
  }>;
  variants: Array<{ productDbId: string; selectedOptions: any }>;
}): ShopCatalogSchema {
  const { shopDomain, products, variants } = params;
  const totalProducts = products.length || 1;

  const variantsByProduct = new Map<string, Array<{ selectedOptions: any }>>();
  for (const variant of variants) {
    const list = variantsByProduct.get(variant.productDbId) || [];
    list.push({ selectedOptions: variant.selectedOptions });
    variantsByProduct.set(variant.productDbId, list);
  }

  const attrStats = new Map<
    string,
    {
      name: string;
      source: ShopCatalogAttribute["source"];
      valueCounts: Map<string, number>;
      productIds: Set<string>;
    }
  >();

  const productTypeCounts = new Map<string, number>();
  const typeAttrCounts = new Map<string, Map<string, number>>();
  const typeTotals = new Map<string, number>();
  const typeValueCounts = new Map<string, Map<string, Map<string, number>>>();

  const addAttributeValue = (
    rawName: string,
    source: ShopCatalogAttribute["source"],
    productId: string,
    rawValue: string,
    productTypeKey?: string
  ) => {
    const name = normalizeKey(rawName);
    const value = normalizeValue(rawValue);
    if (!name || !value) return;

    let entry = attrStats.get(name);
    if (!entry) {
      entry = {
        name: toDisplayName(name),
        source,
        valueCounts: new Map(),
        productIds: new Set()
      };
      attrStats.set(name, entry);
    }
    entry.productIds.add(productId);
    const prev = entry.valueCounts.get(value) || 0;
    entry.valueCounts.set(value, prev + 1);

    if (productTypeKey) {
      const typeMap = typeValueCounts.get(productTypeKey) || new Map();
      const attrMap = typeMap.get(name) || new Map();
      attrMap.set(value, (attrMap.get(value) || 0) + 1);
      typeMap.set(name, attrMap);
      typeValueCounts.set(productTypeKey, typeMap);
    }
  };

  for (const product of products) {
    const productId = product.id;
    const productType = product.productType ? product.productType.trim() : "";
    if (productType) {
      const normalized = normalizeKey(productType);
      productTypeCounts.set(
        productType,
        (productTypeCounts.get(productType) || 0) + 1
      );
      typeTotals.set(normalized, (typeTotals.get(normalized) || 0) + 1);
      if (!typeAttrCounts.has(normalized)) {
        typeAttrCounts.set(normalized, new Map());
      }
      addAttributeValue("product type", "type", productId, productType, normalized);
    }

    if (Array.isArray(product.tags)) {
      for (const tag of product.tags) {
        if (!tag) continue;
        addAttributeValue("tag", "tag", productId, tag, productType ? normalizeKey(productType) : undefined);
      }
    }

    const variantList = variantsByProduct.get(productId) || [];
    for (const variant of variantList) {
      const options = Array.isArray(variant.selectedOptions)
        ? (variant.selectedOptions as Array<{ name?: string; value?: string }>)
        : [];
      for (const opt of options) {
        if (!opt?.name || !opt?.value) continue;
        addAttributeValue(
          opt.name,
          "option",
          productId,
          opt.value,
          productType ? normalizeKey(productType) : undefined
        );
      }
    }

    const text = product.bodyHtml ? stripHtml(product.bodyHtml) : "";
    const textAttrs = extractTextAttributes(text);
    for (const attr of textAttrs) {
      addAttributeValue(
        attr.name,
        "text",
        productId,
        attr.value,
        productType ? normalizeKey(productType) : undefined
      );
    }
  }

  const attributes: ShopCatalogAttribute[] = [];
  for (const entry of attrStats.values()) {
    const valueCounts = Array.from(entry.valueCounts.entries());
    const cardinality = valueCounts.length;
    const coverage = entry.productIds.size / totalProducts;
    const topValues = valueCounts
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value]) => value);
    const attr: ShopCatalogAttribute = {
      name: entry.name,
      source: entry.source,
      coverage: Number(coverage.toFixed(3)),
      cardinality,
      topValues,
      filterable: false
    };
    attr.filterable = isFilterableAttribute(attr);
    attributes.push(attr);
  }

  for (const product of products) {
    const type = product.productType ? normalizeKey(product.productType) : "";
    if (!type) continue;
    const attrMap = typeAttrCounts.get(type);
    if (!attrMap) continue;
    for (const attr of attributes) {
      if (!attr.filterable) continue;
      if (attr.source === "type") continue;
      const normalizedAttr = normalizeKey(attr.name);
      const productHas =
        attrStats.get(normalizedAttr)?.productIds.has(product.id) ?? false;
      if (productHas) {
        attrMap.set(normalizedAttr, (attrMap.get(normalizedAttr) || 0) + 1);
      }
    }
  }

  const typeToAttributes: Record<string, string[]> = {};
  for (const [typeKey, attrMap] of typeAttrCounts.entries()) {
    const total = typeTotals.get(typeKey) || 1;
    const ranked = Array.from(attrMap.entries())
      .map(([attrName, count]) => ({
        attrName,
        coverage: count / total
      }))
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, 6)
      .map((entry) => toDisplayName(entry.attrName));
    if (ranked.length > 0) {
      typeToAttributes[typeKey] = ranked;
    }
  }

  const typeAttributeValues: Record<string, Record<string, string[]>> = {};
  for (const [typeKey, attrMap] of typeValueCounts.entries()) {
    const entry: Record<string, string[]> = {};
    for (const [attrName, values] of attrMap.entries()) {
      const ranked = Array.from(values.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value]) => value);
      if (ranked.length > 0) {
        entry[toDisplayName(attrName)] = ranked;
      }
    }
    if (Object.keys(entry).length > 0) {
      typeAttributeValues[typeKey] = entry;
    }
  }

  return {
    shopDomain,
    updatedAt: new Date().toISOString(),
    productTypes: Array.from(productTypeCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    attributes: attributes.sort((a, b) => b.coverage - a.coverage),
    typeToAttributes,
    typeAttributeValues
  };
}

export async function buildShopCatalogSchema(
  botId: string,
  shopDomain: string,
  productSampleLimit = 300
): Promise<ShopCatalogSchema> {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) {
    throw new Error("Shop not found");
  }
  if (shop.botId && shop.botId !== botId) {
    throw new Error("Shop is linked to a different bot");
  }

  const products = await prisma.shopifyProduct.findMany({
    where: { shopId: shop.id },
    orderBy: { updatedAt: "desc" },
    take: productSampleLimit,
    select: {
      id: true,
      productType: true,
      tags: true,
      bodyHtml: true
    }
  });

  const productIds = products.map((p) => p.id);
  const variants = productIds.length
    ? await prisma.shopifyVariant.findMany({
        where: { shopId: shop.id, productDbId: { in: productIds } },
        select: { productDbId: true, selectedOptions: true }
      })
    : [];

  const schema = buildSchemaFromProducts({
    shopDomain,
    products,
    variants
  });

  await prisma.shopCatalogSchema.upsert({
    where: {
      ShopCatalogSchema_botId_shopDomain_unique: {
        botId,
        shopDomain
      }
    },
    update: {
      schemaJson: schema,
      updatedAt: new Date()
    },
    create: {
      id: crypto.randomUUID(),
      botId,
      shopDomain,
      schemaJson: schema
    }
  });

  const cacheKey = `${botId}:${shopDomain}`;
  schemaCache.set(cacheKey, {
    schema,
    expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS
  });

  return schema;
}
