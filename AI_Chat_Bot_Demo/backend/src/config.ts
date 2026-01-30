import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;

  databaseUrl: string;
  redisUrl: string;

  knowledgeBaseUrl: string;
  knowledgeInternalToken: string;

  openaiApiKey: string;

  whatsappVerifyToken: string | null;
  whatsappAccessToken: string | null;
  whatsappApiBaseUrl: string | null;

  // NEW: optional dedicated redirect URI for WhatsApp embedded signup
  whatsappEmbeddedRedirectUri: string | null;

  metaVerifyToken: string | null;
  metaGraphApiBaseUrl: string | null;
  metaPageAccessToken: string | null;

  googleProjectId: string | null;
  googleClientEmail: string | null;
  googlePrivateKey: string | null;

  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessExpiresIn: number;
  jwtRefreshExpiresIn: number;

  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;

  googleClientId: string | null;
  googleClientSecret: string | null;
  googleAndroidClientId: string | null;

  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  stripePriceIdBasic: string | null;

  // Shopify
  shopifyApiKey: string | null;
  shopifyApiSecret: string | null;
  shopifyScopes: string | null;
  shopifyAppUrl: string | null;
  shopifyApiVersion: string;
  shopifyTokenEncryptionKey: string | null;
  shopifyOrderDataRetentionDays: number;
  shopifyConversationRetentionDays: number;
  shopifyRegisterComplianceWebhooks: boolean;

  metaAppId: string | null;
  metaAppSecret: string | null;
  metaRedirectUri: string | null;

  // Referrals
  referralCookieName: string;
  referralCookieMaxAgeDays: number;
  referralDefaultCommissionBps: number; // 800 = 8%
  referralIpHashSalt: string | null;

  termsVersion: string | null,
  privacyVersion: string | null,
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export const config: AppConfig = {
  port: Number(process.env.PORT || 4000),

  databaseUrl: requireEnv("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL || "redis://redis:6379",

  knowledgeBaseUrl: requireEnv("KNOWLEDGE_BASE_URL"),
  knowledgeInternalToken: requireEnv("KNOWLEDGE_INTERNAL_TOKEN"),

  openaiApiKey: requireEnv("OPENAI_API_KEY"),

  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || null,
  whatsappApiBaseUrl: process.env.WHATSAPP_API_BASE_URL || null,

  // NEW: usually the same as your embedded signup config redirect URI
  whatsappEmbeddedRedirectUri:
    process.env.WHATSAPP_EMBEDDED_REDIRECT_URI || null,

  metaVerifyToken: process.env.META_VERIFY_TOKEN || null,
  metaGraphApiBaseUrl: process.env.META_GRAPH_API_BASE_URL || null,
  metaPageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || null,

  googleProjectId: process.env.GOOGLE_PROJECT_ID || null,
  googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL || null,
  googlePrivateKey: process.env.GOOGLE_PRIVATE_KEY || null,

  jwtAccessSecret: requireEnv("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: requireEnv("JWT_REFRESH_SECRET"),
  jwtAccessExpiresIn: Number(process.env.JWT_ACCESS_EXPIRES_IN || 900),
  jwtRefreshExpiresIn: Number(process.env.JWT_REFRESH_EXPIRES_IN || 2592000),

  smtpHost: process.env.SMTP_HOST || null,
  smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null,
  smtpUser: process.env.SMTP_USER || null,
  smtpPassword: process.env.SMTP_PASSWORD || null,
  smtpFrom: process.env.SMTP_FROM || null,

  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
  googleAndroidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID || null,

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  stripePriceIdBasic: process.env.STRIPE_PRICE_ID_BASIC || null,

  shopifyApiKey: process.env.SHOPIFY_API_KEY || null,
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET || null,
  shopifyScopes: process.env.SHOPIFY_SCOPES || null,
  shopifyAppUrl: process.env.SHOPIFY_APP_URL || null,
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2024-10",
  shopifyTokenEncryptionKey: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY || null,
  shopifyOrderDataRetentionDays: Number(
    process.env.SHOPIFY_ORDER_DATA_RETENTION_DAYS || 90
  ),
  shopifyConversationRetentionDays: Number(
    process.env.SHOPIFY_CONVERSATION_RETENTION_DAYS || 180
  ),
  shopifyRegisterComplianceWebhooks:
    String(process.env.SHOPIFY_REGISTER_COMPLIANCE_WEBHOOKS || "")
      .toLowerCase()
      .trim() === "true",

  metaAppId: process.env.META_APP_ID || null,
  metaAppSecret: process.env.META_APP_SECRET || null,
  metaRedirectUri: process.env.META_REDIRECT_URI || null,

  // Referrals
  referralCookieName: process.env.REFERRAL_COOKIE_NAME || "ref",
  referralCookieMaxAgeDays: Number(process.env.REFERRAL_COOKIE_MAX_AGE_DAYS || 30),
  referralDefaultCommissionBps: Number(process.env.REFERRAL_DEFAULT_COMMISSION_BPS || 800),
  referralIpHashSalt: process.env.REFERRAL_IP_HASH_SALT || null,

  termsVersion: process.env.TERMS_VERSION || "2025-12-18",
  privacyVersion: process.env.PRIVACY_VERSION || "2025-12-18",
};
