import { prisma } from "../prisma/prisma";
import { getShopForBotId } from "./shopService";
import {
  searchShopifyProducts,
  getShopifyProductById
} from "./productService";
import { buildCartUrls, buildCartUrl, toCartVariantId } from "./cartService";
import { lookupOrderByEmailAndNumber } from "./orderService";

function buildBaseUrl(shopDomain: string) {
  return `https://${shopDomain}`;
}

export async function resolveShopForBot(botId: string) {
  const shop = await getShopForBotId(botId);
  if (!shop) {
    throw new Error("Shopify not connected for this assistant.");
  }
  return shop;
}

export async function toolSearchProducts(params: {
  botId: string;
  query?: string;
  priceMin?: number;
  priceMax?: number;
  limit?: number;
  cursor?: number;
}) {
  const shop = await resolveShopForBot(params.botId);
  const shopDomain = shop.shopDomain;
  const baseUrl = buildBaseUrl(shopDomain);

  const result = await searchShopifyProducts(shopDomain, {
    query: params.query,
    priceMin: params.priceMin,
    priceMax: params.priceMax,
    limit: params.limit,
    cursor: params.cursor,
    status: "ACTIVE"
  });

  const enrichedItems = await Promise.all(
    result.items.map(async (item) => {
      const variant = await prisma.shopifyVariant.findFirst({
        where: {
          shopId: shop.id,
          productDbId: item.id,
          availableForSale: true
        },
        orderBy: [
          { inventoryQuantity: "desc" },
          { updatedAt: "desc" }
        ]
      });

      const productUrl = item.handle
        ? `${baseUrl}/products/${item.handle}`
        : null;

      const resolvedImageUrl = item.imageUrl || variant?.imageUrl || null;
      const cartVariantId = variant ? toCartVariantId(variant.variantId) : "";
      const addToCartUrl = variant
        ? `${baseUrl}/cart/add?id=${encodeURIComponent(
            cartVariantId
          )}&quantity=1`
        : null;

      return {
        ...item,
        imageUrl: resolvedImageUrl,
        defaultVariantId: variant?.variantId || null,
        cartVariantId: variant ? cartVariantId : null,
        productUrl,
        addToCartUrl
      };
    })
  );

  return {
    ...result,
    items: enrichedItems
  };
}

export async function toolGetProductDetails(params: {
  botId: string;
  productId: string;
}) {
  const shop = await resolveShopForBot(params.botId);
  const shopDomain = shop.shopDomain;
  return getShopifyProductById(shopDomain, params.productId);
}

export async function toolAddToCart(params: {
  botId: string;
  sessionId: string;
  variantId: string;
  quantity: number;
}) {
  const shop = await resolveShopForBot(params.botId);
  const shopDomain = shop.shopDomain;
  return buildCartUrls({
    shopDomain,
    variantId: params.variantId,
    quantity: params.quantity
  });
}

export async function toolGetCheckoutLink(params: {
  botId: string;
}) {
  const shop = await resolveShopForBot(params.botId);
  const shopDomain = shop.shopDomain;
  return buildCartUrl({ shopDomain });
}

export async function toolGetOrderStatus(params: {
  botId: string;
  email: string;
  orderNumber: string;
}) {
  const shop = await resolveShopForBot(params.botId);
  const shopDomain = shop.shopDomain;
  return lookupOrderByEmailAndNumber({
    shopDomain,
    email: params.email,
    orderNumber: params.orderNumber
  });
}
