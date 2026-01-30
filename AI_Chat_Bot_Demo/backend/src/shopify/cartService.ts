import { prisma } from "../prisma/prisma";
import { getShopByDomain } from "./shopService";

function buildBaseUrl(shopDomain: string) {
  return `https://${shopDomain}`;
}

// Shopify Online Store cart endpoints expect the numeric variant ID, not the gid:// form.
export function toCartVariantId(variantId: string): string {
  const match = variantId.match(/ProductVariant\/(\d+)/);
  return match?.[1] || variantId;
}

export async function buildCartUrls(params: {
  shopDomain: string;
  variantId: string;
  quantity: number;
}) {
  const shop = await getShopByDomain(params.shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const lookupId = params.variantId.startsWith("gid://")
    ? params.variantId
    : `gid://shopify/ProductVariant/${params.variantId}`;

  const variant = await prisma.shopifyVariant.findFirst({
    where: { shopId: shop.id, variantId: lookupId },
    include: { product: true }
  });

  if (!variant) {
    throw new Error("Variant not found");
  }

  const baseUrl = buildBaseUrl(params.shopDomain);
  const handle = variant.product.handle || "";
  const cartVariantId = toCartVariantId(variant.variantId);
  const productUrl = handle
    ? `${baseUrl}/products/${handle}?variant=${encodeURIComponent(cartVariantId)}`
    : null;

  const addToCartUrl = `${baseUrl}/cart/add?id=${encodeURIComponent(
    cartVariantId
  )}&quantity=${encodeURIComponent(params.quantity)}`;

  return {
    productUrl,
    addToCartUrl,
    cartUrl: `${baseUrl}/cart`
  };
}

export async function buildCartUrl(params: { shopDomain: string }) {
  const shop = await getShopByDomain(params.shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  return { cartUrl: `${buildBaseUrl(params.shopDomain)}/cart` };
}
