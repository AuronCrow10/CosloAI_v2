import { config } from "../config";

export function requireShopifyConfig() {
  if (!config.shopifyApiKey || !config.shopifyApiSecret) {
    throw new Error("Shopify API key/secret not configured");
  }
  if (!config.shopifyAppUrl) {
    throw new Error("SHOPIFY_APP_URL not configured");
  }
  if (!config.shopifyTokenEncryptionKey) {
    throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY not configured");
  }

  return {
    apiKey: config.shopifyApiKey,
    apiSecret: config.shopifyApiSecret,
    scopes:
      config.shopifyScopes ||
      "read_products,read_orders,read_fulfillments,write_script_tags",
    appUrl: config.shopifyAppUrl,
    apiVersion: config.shopifyApiVersion,
    tokenEncryptionKey: config.shopifyTokenEncryptionKey
  };
}
