import { Router, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { buildInstallUrl, handleOAuthCallback } from "../shopify/oauthService";
import {
  linkShopToBot,
  normalizeShopDomain
} from "../shopify/shopService";
import { ensureWidgetScriptTag } from "../shopify/scriptTagService";
import {
  syncShopifyProducts,
  searchShopifyProducts,
  syncShopifyProductById,
  deleteShopifyProductById,
  updateVariantInventoryFromItem
} from "../shopify/productService";
import { buildCartUrls, buildCartUrl } from "../shopify/cartService";
import { lookupOrderByEmailAndNumber } from "../shopify/orderService";
import { resolveWidgetConfig } from "../shopify/widgetService";
import { verifyWebhookHmac } from "../shopify/crypto";
import { registerShopifyWebhooks } from "../shopify/webhookService";
import {
  insertShopifyEvent,
  isValidWidgetToken,
  buildEventId,
  isValidTrackingToken,
  ShopifyEventType
} from "../shopify/analyticsService";
import {
  logShopifyDataEvent,
  findCustomerDataSummary,
  redactCustomerData,
  redactShopData
} from "../shopify/dataProtectionService";

const router = Router();

const installSchema = z.object({
  shop: z.string().min(1),
  botId: z.string().optional(),
  returnTo: z.string().optional()
});

const linkSchema = z.object({
  botId: z.string().nullable()
});

const searchSchema = z.object({
  q: z.string().optional(),
  priceMin: z.string().optional(),
  priceMax: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  status: z.string().optional()
});

const cartCreateSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().positive()
});

const shopListSchema = z.object({
  botId: z.string().min(1)
});

const shopLookupSchema = z.object({
  shop: z.string().min(1)
});

const shopifyEventSchema = z.object({
  shopDomain: z.string().min(1),
  botId: z.string().min(1),
  token: z.string().min(1),
  eventType: z.enum(["view_product", "add_to_cart"]),
  sessionId: z.string().optional(),
  conversationId: z.string().optional(),
  productId: z.string().optional(),
  variantId: z.string().optional(),
  meta: z.any().optional()
});

const shopifyTrackSchema = z.object({
  shop: z.string().min(1),
  botId: z.string().min(1),
  event: z.enum(["view_product", "add_to_cart"]),
  target: z.string().min(1),
  token: z.string().min(1),
  conversationId: z.string().optional()
});

const publicInstallSchema = z.object({
  shop: z.string().min(1),
  returnTo: z.string().optional()
});

const publicStatusSchema = z.object({
  shop: z.string().min(1)
});

async function requireShopOwnerAccess(req: Request, shopDomain: string) {
  const shop = await prisma.shopifyShop.findUnique({
    where: { shopDomain },
    include: { bot: true }
  });
  if (!shop) {
    throw new Error("SHOP_NOT_FOUND");
  }
  if (!shop.bot || shop.bot.userId !== req.user!.id) {
    throw new Error("FORBIDDEN");
  }
  return shop;
}

router.get("/shopify/install", requireAuth, async (req: Request, res: Response) => {
  const parsed = installSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const shopDomain = normalizeShopDomain(parsed.data.shop);
  let botId: string | undefined;

  if (parsed.data.botId) {
    const bot = await prisma.bot.findFirst({
      where: { id: parsed.data.botId, userId: req.user!.id }
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found" });
    }
    botId = bot.id;
  }

  const installUrl = await buildInstallUrl({
    shop: shopDomain,
    botId,
    userId: req.user!.id,
    returnTo: parsed.data.returnTo
  });

  return res.redirect(installUrl);
});

function parseProductHandle(url: URL): string | null {
  const match = url.pathname.match(/\/products\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseVariantId(url: URL): string | null {
  const raw = url.searchParams.get("id") || url.searchParams.get("variant");
  return raw ? raw.trim() : null;
}

function appendCartProperties(url: URL, props: Record<string, string>) {
  Object.entries(props).forEach(([key, value]) => {
    if (!value) return;
    const param = `properties[${key}]`;
    if (!url.searchParams.has(param)) {
      url.searchParams.set(param, value);
    }
  });
}

router.get("/shopify/track", async (req: Request, res: Response) => {
  const parsed = shopifyTrackSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(parsed.data.shop);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid shop domain" });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(parsed.data.target);
  } catch {
    return res.status(400).json({ error: "Invalid target URL" });
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: "Invalid target URL" });
  }

  const host = targetUrl.hostname.toLowerCase();
  const normalizedShop = shopDomain.toLowerCase();
  if (host !== normalizedShop && !host.endsWith(`.${normalizedShop}`)) {
    return res.status(400).json({ error: "Target host not allowed" });
  }

  const { botId, token, event, conversationId } = parsed.data;
  const eventType = event as ShopifyEventType;

  if (
    !isValidTrackingToken({
      shopDomain,
      botId,
      eventType,
      targetUrl: parsed.data.target,
      conversationId: conversationId ?? null,
      token
    })
  ) {
    return res.status(401).json({ error: "Invalid tracking token" });
  }

  if (eventType === "add_to_cart") {
    appendCartProperties(targetUrl, {
      coslo_bot_id: botId,
      coslo_conversation_id: conversationId ?? ""
    });
  }

  const eventId = crypto.randomUUID();
  const productHandle = parseProductHandle(targetUrl);
  const variantId = parseVariantId(targetUrl);

  await insertShopifyEvent({
    id: eventId,
    shopDomain,
    botId,
    eventType,
    conversationId: conversationId ?? null,
    productId: productHandle ?? null,
    variantId: variantId ?? null,
    source: "meta",
    meta: {
      targetUrl: targetUrl.toString()
    }
  });

  return res.redirect(targetUrl.toString());
});

router.post("/shopify/events", async (req: Request, res: Response) => {
  const parsed = shopifyEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(parsed.data.shopDomain);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid shop domain" });
  }

  const { botId, token, eventType, sessionId, conversationId, productId, variantId, meta } =
    parsed.data;

  if (!isValidWidgetToken(shopDomain, botId, token)) {
    return res.status(401).json({ error: "Invalid widget token" });
  }

  const eventId = crypto.randomUUID();
  await insertShopifyEvent({
    id: eventId,
    shopDomain,
    botId,
    eventType,
    sessionId: sessionId ?? null,
    conversationId: conversationId ?? null,
    productId: productId ?? null,
    variantId: variantId ?? null,
    source: "widget",
    meta: meta ?? null
  });

  return res.json({ ok: true });
});

router.get("/shopify/install/public", async (req: Request, res: Response) => {
  const parsed = publicInstallSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(parsed.data.shop);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid shop domain" });
  }

  let safeReturnTo: string | undefined;
  if (parsed.data.returnTo && parsed.data.returnTo.startsWith("/")) {
    safeReturnTo = parsed.data.returnTo;
  }

  console.log("[shopify] public install requested", {
    shopDomain,
    returnTo: safeReturnTo ?? null
  });

  const installUrl = await buildInstallUrl({
    shop: shopDomain,
    botId: null,
    userId: null,
    returnTo: safeReturnTo ?? null
  });

  console.log("[shopify] public install redirect", {
    shopDomain,
    installUrlHost: new URL(installUrl).host,
    installUrlPath: new URL(installUrl).pathname
  });

  return res.redirect(installUrl);
});

router.get("/shopify/public/status", async (req: Request, res: Response) => {
  const parsed = publicStatusSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(parsed.data.shop);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid shop domain" });
  }

  const shop = await prisma.shopifyShop.findUnique({
    where: { shopDomain },
    select: { isActive: true, uninstalledAt: true }
  });

  console.log("[shopify] public status", {
    shopDomain,
    exists: !!shop,
    isActive: !!shop?.isActive,
    uninstalledAt: shop?.uninstalledAt ?? null
  });

  return res.json({
    shopDomain,
    exists: !!shop,
    isActive: !!shop?.isActive && !shop?.uninstalledAt
  });
});

router.get("/shopify/auth/callback", async (req: Request, res: Response) => {
  try {
    const rawQuery = req.originalUrl.split("?")[1] || "";
    const shop = String(req.query.shop || "");
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    if (!shop || !code || !state) {
      return res.status(400).json({ error: "Missing OAuth params" });
    }

    console.log("[shopify] oauth callback received", {
      shop,
      hasCode: !!code,
      hasState: !!state
    });

    const result = await handleOAuthCallback({
      rawQuery,
      shop,
      code,
      state
    });

    console.log("[shopify] oauth callback success", {
      shopDomain: result.shopDomain,
      botId: result.botId ?? null,
      userId: result.userId ?? null,
      returnTo: result.returnTo ?? null
    });

    await registerShopifyWebhooks(result.shopDomain);

    if (result.botId && result.userId) {
      const bot = await prisma.bot.findFirst({
        where: { id: result.botId, userId: result.userId }
      });
      if (bot) {
        await linkShopToBot(result.shopDomain, bot.id);
        if (config.shopifyAppUrl) {
          const scriptSrc = `${config.shopifyAppUrl}/embed.js?shop=${encodeURIComponent(
            result.shopDomain
          )}`;
          await ensureWidgetScriptTag(result.shopDomain, scriptSrc);
        }
      }
    }

    const redirectTarget =
      process.env.FRONTEND_ORIGIN ||
      config.shopifyAppUrl ||
      "https://example.com";

    let redirectPath = result.botId
      ? `/app/bots/${encodeURIComponent(result.botId)}/shopify`
      : "/app";

    if (result.returnTo && result.returnTo.startsWith("/")) {
      redirectPath = result.returnTo;
    }

    const joiner = redirectPath.includes("?") ? "&" : "?";
    const redirectUrl =
      `${redirectTarget}${redirectPath}` +
      `${joiner}shopify=installed&shop=${encodeURIComponent(result.shopDomain)}`;

    return res.redirect(redirectUrl);
  } catch (err: any) {
    console.error("Shopify OAuth callback failed", err);
    return res.status(400).json({ error: err.message || "OAuth failed" });
  }
});

function verifyShopifyWebhookRequest(req: Request) {
  const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) return false;
  if (!hmac) return false;
  return verifyWebhookHmac(rawBody, hmac);
}

router.post("/shopify/webhooks/app-uninstalled", async (req: Request, res: Response) => {
  if (!verifyShopifyWebhookRequest(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const shopDomain = req.get("X-Shopify-Shop-Domain") || "";
  if (shopDomain) {
    await prisma.shopifyShop.updateMany({
      where: { shopDomain },
      data: { isActive: false, uninstalledAt: new Date() }
    });
  }

  return res.status(200).json({ ok: true });
});

router.post("/shopify/webhooks/products-update", async (req: Request, res: Response) => {
  if (!verifyShopifyWebhookRequest(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const shopDomain = req.get("X-Shopify-Shop-Domain") || "";
  const productId = (req.body as any)?.id;
  if (shopDomain && productId) {
    await syncShopifyProductById(shopDomain, productId);
  }
  return res.status(200).json({ ok: true });
});

router.post("/shopify/webhooks/products-delete", async (req: Request, res: Response) => {
  if (!verifyShopifyWebhookRequest(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const shopDomain = req.get("X-Shopify-Shop-Domain") || "";
  const productId = (req.body as any)?.id;
  if (shopDomain && productId) {
    await deleteShopifyProductById(shopDomain, productId);
  }
  return res.status(200).json({ ok: true });
});

router.post("/shopify/webhooks/inventory-update", async (req: Request, res: Response) => {
  if (!verifyShopifyWebhookRequest(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const shopDomain = req.get("X-Shopify-Shop-Domain") || "";
  const inventoryItemId = (req.body as any)?.inventory_item_id;
  const available = (req.body as any)?.available;

  if (shopDomain && inventoryItemId != null && typeof available === "number") {
    await updateVariantInventoryFromItem({
      shopDomain,
      inventoryItemId,
      available
    });
  }
  return res.status(200).json({ ok: true });
});

router.post("/shopify/webhooks/orders-create", async (req: Request, res: Response) => {
  if (!verifyShopifyWebhookRequest(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const payload = req.body as any;
  if (payload?.id) {
    console.log("Shopify order created", {
      orderId: payload.id,
      orderNumber: payload.name
    });
  }

  try {
    const shopDomain = req.get("X-Shopify-Shop-Domain") || payload?.shop_domain || "";
    const normalizedShop = shopDomain ? normalizeShopDomain(shopDomain) : "";
    if (!normalizedShop) {
      return res.status(200).json({ ok: true });
    }

    const shopRecord = await prisma.shopifyShop.findUnique({
      where: { shopDomain: normalizedShop },
      select: { botId: true }
    });

    const orderId = payload?.id ? String(payload.id) : null;
    const orderName = payload?.name ? String(payload.name) : null;
    const orderNumber =
      payload?.order_number != null ? String(payload.order_number) : null;
    const currency = payload?.currency ? String(payload.currency) : null;
    const totalPrice = payload?.total_price ? Number(payload.total_price) : null;
    const revenueCents =
      totalPrice != null && Number.isFinite(totalPrice)
        ? Math.round(totalPrice * 100)
        : null;

    const readAttribute = (attrs: any[], key: string): string | null => {
      if (!Array.isArray(attrs)) return null;
      const found = attrs.find(
        (a) =>
          a &&
          (String(a.name || a.key || "").toLowerCase() === key.toLowerCase())
      );
      if (!found) return null;
      return String(found.value ?? "");
    };

    const noteAttrs = payload?.note_attributes || [];
    let sessionId = readAttribute(noteAttrs, "coslo_session_id");
    let conversationId = readAttribute(noteAttrs, "coslo_conversation_id");
    let botIdFromOrder = readAttribute(noteAttrs, "coslo_bot_id");

    if (!sessionId || !conversationId || !botIdFromOrder) {
      const lineItems = Array.isArray(payload?.line_items)
        ? payload.line_items
        : [];
      for (const item of lineItems) {
        const props = item?.properties || [];
        sessionId = sessionId || readAttribute(props, "coslo_session_id");
        conversationId =
          conversationId || readAttribute(props, "coslo_conversation_id");
        botIdFromOrder = botIdFromOrder || readAttribute(props, "coslo_bot_id");
        if (sessionId || conversationId || botIdFromOrder) break;
      }
    }

    const botId = botIdFromOrder || shopRecord?.botId || null;
    if (orderId && botId) {
      const eventId = buildEventId("purchase", [normalizedShop, orderId]);
      await insertShopifyEvent({
        id: eventId,
        shopDomain: normalizedShop,
        botId,
        eventType: "purchase",
        sessionId: sessionId || null,
        conversationId: conversationId || null,
        orderId,
        orderName,
        orderNumber,
        revenueCents,
        currency,
        source: "shopify_webhook",
        meta: {
          lineItemCount: Array.isArray(payload?.line_items)
            ? payload.line_items.length
            : 0
        }
      });
    }
  } catch (err) {
    console.error("Failed to track Shopify purchase", err);
  }
  return res.status(200).json({ ok: true });
});

router.post(
  "/shopify/webhooks/customers/data_request",
  async (req: Request, res: Response) => {
    if (!verifyShopifyWebhookRequest(req)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = req.body as any;
    const shopDomain = payload?.shop_domain || req.get("X-Shopify-Shop-Domain") || "";
    const email = payload?.customer?.email || null;
    const webhookId = req.get("X-Shopify-Webhook-Id") || null;

    const shop = shopDomain
      ? await prisma.shopifyShop.findUnique({ where: { shopDomain } })
      : null;

    const summary = await findCustomerDataSummary({
      shopId: shop?.id ?? null,
      shopDomain,
      customerEmail: email
    });

    await logShopifyDataEvent({
      shopId: shop?.id ?? null,
      shopDomain,
      customerEmail: email,
      eventType: "customers_data_request",
      webhookId,
      payload,
      summary
    });

    return res.status(200).json({ ok: true });
  }
);

router.post(
  "/shopify/webhooks/customers/redact",
  async (req: Request, res: Response) => {
    if (!verifyShopifyWebhookRequest(req)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = req.body as any;
    const shopDomain = payload?.shop_domain || req.get("X-Shopify-Shop-Domain") || "";
    const email = payload?.customer?.email || null;
    const webhookId = req.get("X-Shopify-Webhook-Id") || null;

    const shop = shopDomain
      ? await prisma.shopifyShop.findUnique({ where: { shopDomain } })
      : null;

    await logShopifyDataEvent({
      shopId: shop?.id ?? null,
      shopDomain,
      customerEmail: email,
      eventType: "customers_redact",
      webhookId,
      payload
    });

    await redactCustomerData({
      shopId: shop?.id ?? null,
      shopDomain,
      customerEmail: email
    });

    return res.status(200).json({ ok: true });
  }
);

router.post(
  "/shopify/webhooks/shop/redact",
  async (req: Request, res: Response) => {
    if (!verifyShopifyWebhookRequest(req)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = req.body as any;
    const shopDomain = payload?.shop_domain || req.get("X-Shopify-Shop-Domain") || "";
    const webhookId = req.get("X-Shopify-Webhook-Id") || null;

    await logShopifyDataEvent({
      shopId: null,
      shopDomain,
      customerEmail: null,
      eventType: "shop_redact",
      webhookId,
      payload
    });

    if (shopDomain) {
      await redactShopData({ shopDomain });
    }

    return res.status(200).json({ ok: true });
  }
);

router.get("/shopify/widget-config", async (req: Request, res: Response) => {
  const shop = String(req.query.shop || "");
  if (!shop) {
    return res.status(400).json({ error: "Missing shop" });
  }

  try {
    const config = await resolveWidgetConfig(shop);
    if (!config) return res.status(404).json({ error: "Not found" });
    return res.json(config);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid shop" });
  }
});

router.use("/shopify", requireAuth);

router.get("/shopify/shops/lookup", async (req: Request, res: Response) => {
  const parsed = shopLookupSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(parsed.data.shop);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Invalid shop domain" });
  }

  const shop = await prisma.shopifyShop.findUnique({
    where: { shopDomain },
    include: {
      bot: {
        select: { id: true, userId: true }
      }
    }
  });

  if (!shop) {
    return res.json({ status: "not_found", shopDomain });
  }

  if (!shop.isActive) {
    return res.json({ status: "inactive", shopDomain });
  }

  if (shop.botId && shop.bot?.userId === req.user!.id) {
    return res.json({ status: "linked_to_you", shopDomain, botId: shop.botId });
  }

  if (shop.botId) {
    return res.json({ status: "linked_to_other", shopDomain });
  }

  return res.json({ status: "available", shopDomain });
});

router.get("/shopify/shops", async (req: Request, res: Response) => {
  const parsed = shopListSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const bot = await prisma.bot.findFirst({
    where: { id: parsed.data.botId, userId: req.user!.id }
  });
  if (!bot) {
    return res.status(404).json({ error: "Bot not found" });
  }

  const shops = await prisma.shopifyShop.findMany({
    where: { botId: bot.id },
    orderBy: { installedAt: "desc" },
    select: {
      id: true,
      shopDomain: true,
      isActive: true,
      installedAt: true,
      uninstalledAt: true,
      scopes: true,
      shopCurrency: true,
      lastProductsSyncAt: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          products: true,
          variants: true
        }
      }
    }
  });

  return res.json({
    items: shops.map((shop) => ({
      ...shop,
      productCount: shop._count.products,
      variantCount: shop._count.variants
    }))
  });
});

router.patch("/shopify/shops/:shopDomain/link", async (req: Request, res: Response) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const shopDomain = normalizeShopDomain(req.params.shopDomain);
  const existingShop = await prisma.shopifyShop.findUnique({
    where: { shopDomain }
  });
  if (!existingShop) {
    return res.status(404).json({ error: "Shop not found" });
  }

  if (parsed.data.botId) {
    const bot = await prisma.bot.findFirst({
      where: { id: parsed.data.botId, userId: req.user!.id }
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found" });
    }
  }

  let updated;
  try {
    updated = await linkShopToBot(shopDomain, parsed.data.botId);
  } catch (err: any) {
    if (err?.message === "SHOP_NOT_FOUND") {
      return res.status(404).json({ error: "Shop not found" });
    }
    if (err?.message === "SHOP_ALREADY_LINKED") {
      return res.status(409).json({
        error: "Shop is already linked to another bot. Unlink it first."
      });
    }
    throw err;
  }

  if (updated.botId && config.shopifyAppUrl) {
    const scriptSrc = `${config.shopifyAppUrl}/embed.js?shop=${encodeURIComponent(
      shopDomain
    )}`;
    await ensureWidgetScriptTag(shopDomain, scriptSrc);
  }

  return res.json(updated);
});

router.post("/shopify/:shopDomain/sync/products", async (req: Request, res: Response) => {
  try {
    const shopDomain = normalizeShopDomain(req.params.shopDomain);
    await requireShopOwnerAccess(req, shopDomain);
    const result = await syncShopifyProducts(shopDomain);
    return res.json(result);
  } catch (err: any) {
    if (err.message === "SHOP_NOT_FOUND") {
      return res.status(404).json({ error: "Shop not found" });
    }
    if (err.message === "FORBIDDEN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    console.error("Shopify product sync failed", err);
    return res.status(400).json({ error: err.message || "Sync failed" });
  }
});

router.get("/shopify/:shopDomain/products/search", async (req: Request, res: Response) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const shopDomain = normalizeShopDomain(req.params.shopDomain);
    await requireShopOwnerAccess(req, shopDomain);
    const result = await searchShopifyProducts(shopDomain, {
      query: parsed.data.q,
      priceMin: parsed.data.priceMin ? Number(parsed.data.priceMin) : undefined,
      priceMax: parsed.data.priceMax ? Number(parsed.data.priceMax) : undefined,
      limit: parsed.data.limit ? Number(parsed.data.limit) : undefined,
      cursor: parsed.data.cursor ? Number(parsed.data.cursor) : undefined,
      status: parsed.data.status
    });
    return res.json(result);
  } catch (err: any) {
    if (err.message === "SHOP_NOT_FOUND") {
      return res.status(404).json({ error: "Shop not found" });
    }
    if (err.message === "FORBIDDEN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(400).json({ error: err.message || "Search failed" });
  }
});

router.post("/shopify/:shopDomain/cart", async (req: Request, res: Response) => {
  const parsed = cartCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const shopDomain = normalizeShopDomain(req.params.shopDomain);
    await requireShopOwnerAccess(req, shopDomain);
    const urls = await buildCartUrls({
      shopDomain,
      variantId: parsed.data.variantId,
      quantity: parsed.data.quantity
    });
    return res.json(urls);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Cart error" });
  }
});

router.get(
  "/shopify/:shopDomain/cart/checkout-url",
  async (req: Request, res: Response) => {
    try {
      const shopDomain = normalizeShopDomain(req.params.shopDomain);
      await requireShopOwnerAccess(req, shopDomain);
      const result = await buildCartUrl({ shopDomain });
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "Checkout error" });
    }
  }
);

router.get("/shopify/:shopDomain/orders/lookup", async (req: Request, res: Response) => {
  const email = String(req.query.email || "");
  const orderNumber = String(req.query.orderNumber || "");
  if (!email || !orderNumber) {
    return res.status(400).json({ error: "Missing email or orderNumber" });
  }

  try {
    const shopDomain = normalizeShopDomain(req.params.shopDomain);
    await requireShopOwnerAccess(req, shopDomain);
    const result = await lookupOrderByEmailAndNumber({
      shopDomain,
      email,
      orderNumber
    });
    return res.json({ order: result });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Lookup failed" });
  }
});

export default router;

// This is a public Shopify app that uses only the Admin API plus Online Store/Ajax Cart URLs.
// Storefront API usage is intentionally excluded to comply with public app restrictions.
// PCD handling: customers/data_request, customers/redact, and shop/redact are implemented.
// Product/inventory data is cached for performance and cleared on shop redact/uninstall.
// Order data is fetched on demand for order status lookups and retained for limited time.
