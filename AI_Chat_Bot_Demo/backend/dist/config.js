"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function requireEnv(key) {
    const v = process.env[key];
    if (!v)
        throw new Error(`Missing env var: ${key}`);
    return v;
}
exports.config = {
    port: Number(process.env.PORT || 4000),
    databaseUrl: requireEnv("DATABASE_URL"),
    knowledgeBaseUrl: requireEnv("KNOWLEDGE_BASE_URL"),
    knowledgeInternalToken: requireEnv("KNOWLEDGE_INTERNAL_TOKEN"),
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || null,
    whatsappApiBaseUrl: process.env.WHATSAPP_API_BASE_URL || null,
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
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    stripePriceIdBasic: process.env.STRIPE_PRICE_ID_BASIC || null,
    metaAppId: process.env.META_APP_ID || null,
    metaAppSecret: process.env.META_APP_SECRET || null,
    metaRedirectUri: process.env.META_REDIRECT_URI || null
};
