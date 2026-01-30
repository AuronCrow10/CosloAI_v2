import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { markShopUninstalled } from "./shopService";

type DataEventType =
  | "customers_data_request"
  | "customers_redact"
  | "shop_redact";

type DataSummary = {
  messageMatches?: number;
  conversationsMatched?: number;
};

function normalizeEmail(email?: string | null) {
  return email ? email.trim().toLowerCase() : null;
}

function hashEmail(email?: string | null) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function sanitizeWebhookPayload(payload: any) {
  if (!payload || typeof payload !== "object") return payload;

  const redactKeys = new Set([
    "email",
    "phone",
    "phone_number",
    "address1",
    "address2",
    "city",
    "province",
    "zip",
    "country",
    "name",
    "first_name",
    "last_name"
  ]);

  const walk = (value: any): any => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (!value || typeof value !== "object") {
      return value;
    }

    const next: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (redactKeys.has(key)) {
        next[key] = "[redacted]";
      } else {
        next[key] = walk(val);
      }
    }
    return next;
  };

  return walk(payload);
}

export async function findCustomerDataSummary(params: {
  shopId?: string | null;
  shopDomain?: string | null;
  customerEmail?: string | null;
}): Promise<DataSummary> {
  const email = normalizeEmail(params.customerEmail);
  if (!email) return {};

  const shopFilter = params.shopId
    ? { shopifyShops: { some: { id: params.shopId } } }
    : params.shopDomain
      ? { shopifyShops: { some: { shopDomain: params.shopDomain } } }
      : undefined;

  if (!shopFilter) return {};

  const messageMatches = await prisma.message.count({
    where: {
      content: { contains: email, mode: "insensitive" },
      conversation: {
        bot: shopFilter
      }
    }
  });

  const conversationsMatched = await prisma.conversation.count({
    where: {
      bot: shopFilter,
      messages: {
        some: {
          content: { contains: email, mode: "insensitive" }
        }
      }
    }
  });

  return { messageMatches, conversationsMatched };
}

export async function logShopifyDataEvent(params: {
  shopId?: string | null;
  shopDomain?: string | null;
  customerEmail?: string | null;
  eventType: DataEventType;
  webhookId?: string | null;
  payload: any;
  summary?: DataSummary;
}) {
  const hashedEmail = hashEmail(params.customerEmail);

  if (params.webhookId) {
    const existing = await prisma.shopifyDataEvent.findUnique({
      where: { webhookId: params.webhookId }
    });
    if (existing) return existing;
  }

  const sanitizedPayload = sanitizeWebhookPayload(params.payload);
  const payloadJson =
    params.summary && Object.keys(params.summary).length > 0
      ? { ...sanitizedPayload, dataSummary: params.summary }
      : sanitizedPayload;

  return prisma.shopifyDataEvent.create({
    data: {
      shopId: params.shopId ?? null,
      shopDomain: params.shopDomain ?? null,
      customerEmail: hashedEmail,
      eventType: params.eventType,
      webhookId: params.webhookId ?? null,
      payloadJson,
      processedAt: new Date()
    }
  });
}

export async function redactCustomerData(params: {
  shopId?: string | null;
  shopDomain?: string | null;
  customerEmail?: string | null;
}) {
  const emailHash = hashEmail(params.customerEmail);
  const normalizedEmail = normalizeEmail(params.customerEmail);
  if (!emailHash) {
    return { eventsRedacted: 0 };
  }

  const shopFilter = params.shopId
    ? { shopifyShops: { some: { id: params.shopId } } }
    : params.shopDomain
      ? { shopifyShops: { some: { shopDomain: params.shopDomain } } }
      : undefined;

  const result = await prisma.shopifyDataEvent.updateMany({
    where: {
      customerEmail: emailHash
    },
    data: {
      customerEmail: "redacted",
      payloadJson: Prisma.JsonNull
    }
  });

  let messagesRedacted = 0;
  let conversationsUpdated = 0;

  if (normalizedEmail && shopFilter) {
    const deleted = await prisma.message.deleteMany({
      where: {
        content: { contains: normalizedEmail, mode: "insensitive" },
        conversation: { bot: shopFilter }
      }
    });
    messagesRedacted = deleted.count;

    const updated = await prisma.conversation.updateMany({
      where: {
        memorySummary: { contains: normalizedEmail, mode: "insensitive" },
        bot: shopFilter
      },
      data: {
        memorySummary: null,
        memorySummaryUpdatedAt: new Date()
      }
    });
    conversationsUpdated = updated.count;
  }

  return { eventsRedacted: result.count, messagesRedacted, conversationsUpdated };
}

export async function redactShopData(params: { shopDomain: string }) {
  const shop = await prisma.shopifyShop.findUnique({
    where: { shopDomain: params.shopDomain }
  });

  if (!shop) {
    return { deleted: 0 };
  }

  if (shop.botId) {
    await prisma.message.deleteMany({
      where: { conversation: { botId: shop.botId } }
    });
    await prisma.conversation.deleteMany({ where: { botId: shop.botId } });
  }

  await prisma.shopifyVariant.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopifyProduct.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopifyDataEvent.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopifyShop.delete({ where: { id: shop.id } });

  await markShopUninstalled(params.shopDomain);

  return { deleted: 1 };
}

export async function cleanupExpiredShopifyData() {
  const retentionDays = config.shopifyOrderDataRetentionDays;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const deletedEvents = await prisma.shopifyDataEvent.deleteMany({
    where: {
      createdAt: { lt: cutoff }
    }
  });

  const conversationCutoff = new Date(
    Date.now() - config.shopifyConversationRetentionDays * 24 * 60 * 60 * 1000
  );
  const deletedMessages = await prisma.message.deleteMany({
    where: {
      createdAt: { lt: conversationCutoff },
      conversation: {
        bot: {
          shopifyShops: { some: {} }
        }
      }
    }
  });

  return {
    deletedEvents: deletedEvents.count,
    deletedMessages: deletedMessages.count,
    cutoff,
    conversationCutoff
  };
}

let shopifyCleanupJobStarted = false;

export function scheduleShopifyDataCleanupJob() {
  if (shopifyCleanupJobStarted) return;
  shopifyCleanupJobStarted = true;

  const intervalMs = 24 * 60 * 60 * 1000;

  console.log(
    `Starting Shopify data cleanup job (every ${intervalMs / (60 * 60 * 1000)}h)`
  );

  cleanupExpiredShopifyData().catch((err) =>
    console.error("Initial Shopify data cleanup failed", err)
  );

  setInterval(() => {
    cleanupExpiredShopifyData().catch((err) =>
      console.error("Scheduled Shopify data cleanup failed", err)
    );
  }, intervalMs);
}
