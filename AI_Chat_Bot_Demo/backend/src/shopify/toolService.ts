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
  let order: ShopifyOrderLookupResult | null = null;
  try {
    order = await lookupOrderByEmailAndNumber({
      shopDomain,
      email: params.email,
      orderNumber: params.orderNumber
    });
  } catch (err) {
    console.error("[shopify][order-status] lookup failed", {
      shopDomain,
      botId: params.botId,
      orderNumber: params.orderNumber,
      email: params.email,
      error: err
    });
    throw err;
  }

  if (!order) {
    return {
      found: false,
      message:
        "No order found for that email and order number. Ask the user to double-check both."
    };
  }

  const fulfillmentStatus = (order.fulfillmentStatus || "").toUpperCase();
  const tracking = order.fulfillments
    .filter((f) => f.trackingNumber || f.trackingUrl || f.trackingCompany)
    .map((f) => ({
      company: f.trackingCompany || null,
      number: f.trackingNumber || null,
      url: f.trackingUrl || null,
      status: f.status || null
    }));

  const isPartial =
    fulfillmentStatus === "PARTIALLY_FULFILLED" ||
    fulfillmentStatus === "PARTIAL" ||
    fulfillmentStatus.includes("PARTIAL");

  const isUnshipped = [
    "UNFULFILLED",
    "PENDING",
    "ON_HOLD",
    "SCHEDULED",
    "IN_PROGRESS"
  ].includes(fulfillmentStatus);

  let statusLabel = "processing";
  if (fulfillmentStatus === "FULFILLED") {
    statusLabel = tracking.length > 0 ? "in transit" : "fulfilled";
  } else if (isPartial) {
    statusLabel = "partially fulfilled";
  } else if (fulfillmentStatus === "DELIVERED") {
    statusLabel = "delivered";
  } else if (isUnshipped) {
    statusLabel = "not shipped yet";
  } else if (fulfillmentStatus) {
    statusLabel = fulfillmentStatus.toLowerCase().replace(/_/g, " ");
  }

  const summary = `Order ${order.orderName} is ${statusLabel}.`;
  const partialNote = isPartial
    ? "Some items have shipped separately. The rest are still pending."
    : null;
  const addressNote = isUnshipped
    ? "If you need to change the delivery address, let us know as soon as possible."
    : "If the address is wrong, please contact support immediately.";
  const deliveryNote =
    tracking.length > 0
      ? "If tracking hasn’t updated in 48 hours, contact the carrier or support."
      : null;

  return {
    found: true,
    order,
    summary,
    statusLabel,
    isPartial,
    canChangeAddress: isUnshipped,
    tracking,
    guidance: {
      partialNote,
      addressNote,
      deliveryNote
    }
  };
}
