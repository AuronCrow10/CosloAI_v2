import axios from "axios";
import { getRedis } from "../services/redisClient";
import { requireShopifyConfig } from "./config";
import { generateNonce, verifyShopifyHmac } from "./crypto";
import { normalizeShopDomain, upsertShopInstall } from "./shopService";

const OAUTH_STATE_PREFIX = "shopify:oauth:state:";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export async function buildInstallUrl(params: {
  shop: string;
  botId?: string | null;
  userId?: string | null;
  returnTo?: string | null;
}) {
  const config = requireShopifyConfig();
  const shopDomain = normalizeShopDomain(params.shop);
  const state = generateNonce(16);

  const redis = getRedis();
  await redis.set(
    `${OAUTH_STATE_PREFIX}${state}`,
    JSON.stringify({
      shopDomain,
      botId: params.botId || null,
      userId: params.userId || null,
      returnTo: params.returnTo || null
    }),
    "EX",
    OAUTH_STATE_TTL_SECONDS
  );

  const redirectUri = `${config.appUrl}/api/shopify/auth/callback`;
  const scopes = config.scopes;
  const installUrl =
    `https://${shopDomain}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(config.apiKey)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  return installUrl;
}

export async function handleOAuthCallback(params: {
  rawQuery: string;
  shop: string;
  code: string;
  state: string;
}) {
  const config = requireShopifyConfig();

  if (!verifyShopifyHmac(params.rawQuery)) {
    console.error("[shopify] oauth invalid hmac", {
      shop: params.shop
    });
    throw new Error("Invalid Shopify HMAC");
  }

  const shopDomain = normalizeShopDomain(params.shop);
  const redis = getRedis();
  const stateKey = `${OAUTH_STATE_PREFIX}${params.state}`;
  const cached = await redis.get(stateKey);
  if (!cached) {
    console.error("[shopify] oauth state missing/expired", {
      shopDomain,
      stateKey
    });
    throw new Error("Invalid or expired OAuth state");
  }
  await redis.del(stateKey);
  const cachedState = JSON.parse(cached) as {
    shopDomain: string;
    botId?: string | null;
    userId?: string | null;
    returnTo?: string | null;
  };
  if (cachedState.shopDomain !== shopDomain) {
    console.error("[shopify] oauth state shop mismatch", {
      shopDomain,
      cachedShop: cachedState.shopDomain
    });
    throw new Error("OAuth state shop mismatch");
  }

  console.log("[shopify] oauth state ok", {
    shopDomain,
    hasUserId: !!cachedState.userId,
    hasBotId: !!cachedState.botId
  });

  const accessRes = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      client_id: config.apiKey,
      client_secret: config.apiSecret,
      code: params.code
    },
    { timeout: 20000 }
  );

  const accessToken = accessRes.data?.access_token as string | undefined;
  const scopes = accessRes.data?.scope as string | undefined;
  if (!accessToken || !scopes) {
    console.error("[shopify] oauth access token missing", {
      shopDomain,
      hasToken: !!accessToken,
      hasScopes: !!scopes
    });
    throw new Error("Missing access token from Shopify");
  }

  console.log("[shopify] oauth access token received", {
    shopDomain,
    scopes
  });

  await upsertShopInstall({
    shopDomain,
    accessToken,
    scopes
  });

  return {
    shopDomain,
    botId: cachedState.botId || null,
    userId: cachedState.userId || null,
    returnTo: cachedState.returnTo || null
  };
}
