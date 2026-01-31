import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { config } from "../config";

export type ShopifyEventType =
  | "view_product"
  | "add_to_cart"
  | "purchase";

export type ShopifyEventPayload = {
  id: string;
  shopDomain: string;
  botId: string | null;
  eventType: ShopifyEventType;
  sessionId?: string | null;
  conversationId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  orderNumber?: string | null;
  revenueCents?: number | null;
  currency?: string | null;
  source?: string | null;
  meta?: any;
};

function getWidgetSecret(): string {
  return (
    config.shopifyTokenEncryptionKey ||
    config.shopifyApiSecret ||
    "missing-shopify-secret"
  );
}

export function createWidgetToken(shopDomain: string, botId: string): string {
  const secret = getWidgetSecret();
  return crypto
    .createHmac("sha256", secret)
    .update(`${shopDomain}:${botId}`)
    .digest("hex");
}

export function isValidWidgetToken(
  shopDomain: string,
  botId: string,
  token: string
): boolean {
  if (!token) return false;
  const expected = createWidgetToken(shopDomain, botId);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createTrackingToken(params: {
  shopDomain: string;
  botId: string;
  eventType: ShopifyEventType;
  targetUrl: string;
  conversationId?: string | null;
}): string {
  const secret = getWidgetSecret();
  const base = [
    params.shopDomain,
    params.botId,
    params.eventType,
    params.targetUrl,
    params.conversationId || ""
  ].join("|");
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

export function isValidTrackingToken(params: {
  shopDomain: string;
  botId: string;
  eventType: ShopifyEventType;
  targetUrl: string;
  conversationId?: string | null;
  token: string;
}): boolean {
  const expected = createTrackingToken({
    shopDomain: params.shopDomain,
    botId: params.botId,
    eventType: params.eventType,
    targetUrl: params.targetUrl,
    conversationId: params.conversationId
  });
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(params.token || "", "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function insertShopifyEvent(payload: ShopifyEventPayload) {
  const {
    id,
    shopDomain,
    botId,
    eventType,
    sessionId,
    conversationId,
    productId,
    variantId,
    orderId,
    orderName,
    orderNumber,
    revenueCents,
    currency,
    source,
    meta
  } = payload;

  return prisma.$executeRaw`
    INSERT INTO shopify_analytics_event
      (id, shop_domain, bot_id, event_type, session_id, conversation_id, product_id, variant_id,
       order_id, order_name, order_number, revenue_cents, currency, source, meta)
    VALUES
      (${id}, ${shopDomain}, ${botId}, ${eventType}, ${sessionId}, ${conversationId}, ${productId}, ${variantId},
       ${orderId}, ${orderName}, ${orderNumber}, ${revenueCents}, ${currency}, ${source}, ${meta})
    ON CONFLICT (id) DO NOTHING
  `;
}

export function buildEventId(prefix: string, parts: string[]): string {
  const raw = `${prefix}:${parts.join(":")}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}
