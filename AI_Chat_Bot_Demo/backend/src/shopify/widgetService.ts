import { prisma } from "../prisma/prisma";
import { normalizeShopDomain } from "./shopService";
import { createWidgetToken } from "./analyticsService";

export async function resolveWidgetConfig(shop: string) {
  const shopDomain = normalizeShopDomain(shop);
  const record = await prisma.shopifyShop.findUnique({
    where: { shopDomain },
    include: { bot: true }
  });

  if (!record || !record.isActive || !record.bot) {
    return null;
  }

  const widgetToken = createWidgetToken(record.shopDomain, record.bot.id);

  return {
    botId: record.bot.id,
    botSlug: record.bot.slug,
    botName: record.bot.name,
    widgetToken
  };
}
