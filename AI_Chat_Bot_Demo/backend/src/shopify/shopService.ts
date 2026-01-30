import { prisma } from "../prisma/prisma";
import { encryptToken, decryptToken } from "./crypto";

export function normalizeShopDomain(raw: string): string {
  const shop = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error("Invalid shop domain");
  }
  return shop;
}

export async function getShopByDomain(shopDomain: string) {
  return prisma.shopifyShop.findUnique({
    where: { shopDomain }
  });
}

export async function upsertShopInstall(params: {
  shopDomain: string;
  accessToken: string;
  scopes: string;
  shopCurrency?: string | null;
}) {
  const encrypted = encryptToken(params.accessToken);

  return prisma.shopifyShop.upsert({
    where: { shopDomain: params.shopDomain },
    update: {
      accessTokenEncrypted: encrypted,
      scopes: params.scopes,
      installedAt: new Date(),
      uninstalledAt: null,
      isActive: true,
      shopCurrency: params.shopCurrency ?? null,
      updatedAt: new Date()
    },
    create: {
      shopDomain: params.shopDomain,
      accessTokenEncrypted: encrypted,
      scopes: params.scopes,
      installedAt: new Date(),
      uninstalledAt: null,
      isActive: true,
      shopCurrency: params.shopCurrency ?? null
    }
  });
}

export async function markShopUninstalled(shopDomain: string) {
  return prisma.shopifyShop.updateMany({
    where: { shopDomain },
    data: {
      isActive: false,
      uninstalledAt: new Date()
    }
  });
}

export async function linkShopToBot(shopDomain: string, botId: string | null) {
  const shop = await prisma.shopifyShop.findUnique({
    where: { shopDomain },
    select: { botId: true }
  });

  if (!shop) {
    throw new Error("SHOP_NOT_FOUND");
  }

  if (botId && shop.botId && shop.botId !== botId) {
    throw new Error("SHOP_ALREADY_LINKED");
  }

  return prisma.shopifyShop.update({
    where: { shopDomain },
    data: { botId }
  });
}

export async function getShopForBotId(botId: string) {
  return prisma.shopifyShop.findFirst({
    where: { botId, isActive: true }
  });
}

export function decryptAccessToken(shop: { accessTokenEncrypted: string }) {
  return decryptToken(shop.accessTokenEncrypted);
}
