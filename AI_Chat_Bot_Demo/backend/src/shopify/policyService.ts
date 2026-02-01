import { prisma } from "../prisma/prisma";
import { shopifyAdminGraphql } from "./client";
import { decryptAccessToken, getShopByDomain, getShopForBotId } from "./shopService";

type ShopifyPolicyNode = {
  type: string;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  updatedAt?: string | null;
};

const POLICIES_QUERY = `
  query ShopPolicies {
    shop {
      shopPolicies {
        type
        title
        body
        url
        updatedAt
      }
    }
  }
`;

export async function syncShopifyPolicies(shopDomain: string) {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const accessToken = decryptAccessToken(shop);
  const data = await shopifyAdminGraphql<{
    shop: { shopPolicies: ShopifyPolicyNode[] };
  }>(shopDomain, accessToken, POLICIES_QUERY, {});

  const policies = data.shop?.shopPolicies || [];
  for (const policy of policies) {
    await prisma.shopifyPolicy.upsert({
      where: {
        shopId_type: {
          shopId: shop.id,
          type: policy.type
        }
      },
      update: {
        title: policy.title ?? null,
        body: policy.body ?? null,
        url: policy.url ?? null,
        shopifyUpdatedAt: policy.updatedAt ? new Date(policy.updatedAt) : null,
        updatedAt: new Date()
      },
      create: {
        shopId: shop.id,
        type: policy.type,
        title: policy.title ?? null,
        body: policy.body ?? null,
        url: policy.url ?? null,
        shopifyUpdatedAt: policy.updatedAt ? new Date(policy.updatedAt) : null
      }
    });
  }

  console.log("[shopify] policy sync ok", {
    shopDomain,
    policyCount: policies.length
  });

  return { policyCount: policies.length };
}

export async function getPoliciesForBot(botId: string) {
  const shop = await getShopForBotId(botId);
  if (!shop) return null;

  const policies = await prisma.shopifyPolicy.findMany({
    where: { shopId: shop.id },
    select: {
      type: true,
      title: true,
      body: true,
      url: true,
      shopifyUpdatedAt: true
    },
    orderBy: { type: "asc" }
  });

  const cleaned = policies.filter((p) => p.body || p.title || p.url);
  if (cleaned.length === 0) return null;
  return cleaned;
}
