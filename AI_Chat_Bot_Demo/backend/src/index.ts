// index.ts

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import helmet from "helmet";

import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { verifyAccessToken } from "./services/authService";

import { config } from "./config";
import authRouter from "./routes/auth";
import botsRouter from "./routes/bots";
import botChannelsRouter from "./routes/botChannel";
import botKnowledgeRouter from "./routes/botKnowledge";
import billingRouter from "./routes/billing";
import chatRouter from "./routes/chat";
import whatsappWebhookRouter from "./routes/whatsappWebhook";
import metaWebhookRouter from "./routes/metaWebhook";
import { stripeWebhookHandler } from "./routes/stripeWebhook";
import conversationsRouter from "./routes/conversations";
import metaAuthRouter from "./routes/metaAuth";
import whatsappEmbeddedRouter from "./routes/whatsappEmbedded";
import { scheduleMetaTokenRefreshJob } from "./services/metaTokenService";
import usageRouter from "./routes/usage";
import accountRouter from "./routes/account";
import dashboardRouter from "./routes/dashboard";
import whatsappTemplatesRouter from "./routes/whatsappTemplates";
import shopifyRouter from "./routes/shopify";
import { prisma } from "./prisma/prisma";
import { normalizeShopDomain } from "./shopify/shopService";

import referralsRouter from "./routes/referrals";
import adminUsersRouter from "./routes/adminUsers";
import adminBotsRouter from "./routes/adminBots";
import adminBookingsRouter from "./routes/adminBookings";
import adminEmailUsageRouter from "./routes/adminEmailUsage";
import adminPaymentsRouter from "./routes/adminPayments";
import adminOpenAIUsageRouter from "./routes/adminOpenAIUsage";
import adminIntegrationsRouter from "./routes/adminIntegrations";
import adminPlansRouter from "./routes/adminPlans";
import teamRouter from "./routes/team";
// NEW: booking reminder scheduler
import { scheduleBookingReminderJob } from "./services/bookingReminderService";
import { scheduleShopifyDataCleanupJob } from "./shopify/dataProtectionService";
import mobileDevicesRouter from "./routes/mobileDevices";

const app = express();

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  path: "/socket.io",
  cors: {
    origin: true,          // reflect Origin header; good for dev
    credentials: true
  }
});

// Authenticate sockets using the same JWT as your HTTP API
io.use((socket, next) => {
  const rawToken = socket.handshake.auth?.token as string | undefined;
  if (!rawToken) {
    return next(new Error("Unauthorized"));
  }

  try {
    const payload = verifyAccessToken(rawToken);
    (socket as any).userId = payload.sub;
    return next();
  } catch {
    return next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId = (socket as any).userId as string | undefined;

  if (userId) {
    // All sockets for this user join the same room
    socket.join(`user:${userId}`);
  }

  console.log("Socket connected", socket.id, "user", userId);

  socket.on("disconnect", () => {
    console.log("Socket disconnected", socket.id);
  });
});

// Make io available to all routes via req.app.get("io")
app.set("io", io);


// IMPORTANT behind proxies (Render/Fly/Nginx/Cloudflare)
app.set("trust proxy", 1);

// Stripe webhook uses raw body; mount BEFORE json middleware
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }) as any,
  stripeWebhookHandler
);

// Capture raw body for webhook signature verification while still parsing JSON
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    }
  })
);
app.use(cookieParser());
app.disable("x-powered-by");

const mainCspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  formAction: ["'self'"],
  imgSrc: ["'self'", "data:", "https:"],
  fontSrc: ["'self'", "data:", "https:"],
  styleSrc: ["'self'", "'unsafe-inline'", "https:"],
  scriptSrc: [
    "'self'",
    "'wasm-unsafe-eval'",
    "https://accounts.google.com",
    "https://connect.facebook.net",
    "https://www.googletagmanager.com",
    "https://coslo.it"
  ],
  frameSrc: [
    "'self'",
    "https://accounts.google.com",
    "https://*.google.com",
    "https://www.facebook.com"
  ],
  connectSrc: [
    "'self'",
    "https://accounts.google.com",
    "https://oauth2.googleapis.com",
    "https://www.googleapis.com",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://graph.facebook.com",
    "https://*.facebook.com",
    "wss:"
  ]
};

const cspReportOnly = process.env.CSP_REPORT_ONLY === "1";
const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  (mainCspDirectives as any).upgradeInsecureRequests = [];
}

const widgetFrameAncestors = (process.env.WIDGET_FRAME_ANCESTORS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const widgetCspDirectives = {
  ...mainCspDirectives,
  frameAncestors: widgetFrameAncestors.length ? widgetFrameAncestors : ["*"]
};

const shopifyFrameAncestors = (process.env.SHOPIFY_FRAME_ANCESTORS ||
  "https://admin.shopify.com,https://*.myshopify.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const shopifyCspDirectives = {
  ...mainCspDirectives,
  frameAncestors: shopifyFrameAncestors.length
    ? shopifyFrameAncestors
    : ["https://admin.shopify.com", "https://*.myshopify.com"]
};

// Base security headers; CSP + frameguard handled per-route below
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginResourcePolicy: false
  })
);

const mainCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: mainCspDirectives,
  reportOnly: cspReportOnly
});

const widgetCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: widgetCspDirectives,
  reportOnly: cspReportOnly
});

const shopifyCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: shopifyCspDirectives,
  reportOnly: cspReportOnly
});

const isShopifyEmbeddedRequest = (req: express.Request): boolean => {
  const q = req.query as Record<string, unknown>;
  return q?.embedded === "1" || typeof q?.shop === "string";
};

app.use((req, res, next) => {
  if (req.path.startsWith("/widget")) {
    return widgetCsp(req, res, next);
  }
  if (isShopifyEmbeddedRequest(req)) {
    return shopifyCsp(req, res, next);
  }
  return mainCsp(req, res, next);
});

app.use((req, res, next) => {
  if (req.path === "/embed.js") {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  } else {
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }
  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/widget") && !isShopifyEmbeddedRequest(req)) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
  next();
});

/**
 * Fix OAuth / postMessage console warning:
 * COOP "same-origin" can break auth popups; allow-popups keeps it safe while enabling sign-in flows.
 * If nginx sets headers, mirror this there too (nginx can override Express).
 */
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

/**
 * CORS:
 * ...
 * (your existing CORS block unchanged)
 */
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors((req, cb) => {
    const origin = req.header("Origin");
    const isWidgetConfig = req.path === "/api/shopify/widget-config";
    const isMyShopifyOrigin = origin
      ? /^https:\/\/[a-z0-9-]+\.myshopify\.com$/i.test(origin)
      : false;

    // Non-browser clients / same-origin requests might not send Origin
    if (!origin) {
      return cb(null, { origin: true, credentials: true });
    }

    if (isWidgetConfig && isMyShopifyOrigin) {
      return cb(null, { origin: true, credentials: true });
    }

    if (allowedOrigins.length > 0) {
      return cb(null, {
        origin: allowedOrigins.includes(origin),
        credentials: true
      });
    }

    if (process.env.NODE_ENV !== "production") {
      // reflect any origin in dev
      return cb(null, { origin: true, credentials: true });
    }

    // prod: no CORS headers (same-origin expected)
    return cb(null, { origin: false, credentials: true });
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Auth & SaaS routes
app.use("/auth", authRouter);
app.use("/api", botsRouter);
app.use("/api", botChannelsRouter);
app.use("/api", botKnowledgeRouter);
app.use("/api", billingRouter);
app.use("/api", conversationsRouter);
app.use("/api", metaAuthRouter);
app.use("/api", whatsappEmbeddedRouter);
app.use("/api", usageRouter);

app.use("/api/account", accountRouter);
app.use("/api", dashboardRouter);
app.use("/api", whatsappTemplatesRouter);
app.use("/api", shopifyRouter);
app.use("/api", teamRouter);


app.use("/api", adminUsersRouter);
app.use("/api", referralsRouter);
app.use("/api", adminBotsRouter);
app.use("/api", adminBookingsRouter);
app.use("/api", adminEmailUsageRouter);
app.use("/api", adminPaymentsRouter);
app.use("/api", adminOpenAIUsageRouter);
app.use("/api", adminIntegrationsRouter);
app.use("/api", adminPlansRouter);


// Chat & webhooks
app.use("/api", chatRouter);
app.use("/webhook/whatsapp", whatsappWebhookRouter);
app.use("/webhook/meta", metaWebhookRouter);

// Mobile App

app.use("/api", mobileDevicesRouter);

// If you serve static frontend from this service:
const publicDir = path.join(__dirname, "..", "public");

app.get("/", async (req, res, next) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = req.query.embedded === "1" || !!shop;

  if (!embedded || !shop) {
    return next();
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(shop);
  } catch (err: any) {
    console.warn("[shopify] invalid shop param on /", { shop });
    return next();
  }

  try {
    const record = await prisma.shopifyShop.findUnique({
      where: { shopDomain },
      select: { isActive: true, uninstalledAt: true }
    });

    const isActive = !!record?.isActive && !record?.uninstalledAt;
    console.log("[shopify] embedded root hit", {
      shopDomain,
      isActive
    });

    if (!isActive) {
      const returnTo = `/?embedded=1&shop=${encodeURIComponent(shopDomain)}`;
      const installUrl =
        `/api/shopify/install/public?shop=${encodeURIComponent(shopDomain)}` +
        `&returnTo=${encodeURIComponent(returnTo)}`;
      return res.redirect(installUrl);
    }
  } catch (err) {
    console.error("[shopify] embedded root check failed", err);
  }

  return next();
});

app.use(express.static(publicDir));

// 404 for unknown API
app.use("/api/*", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Error handler
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

server.listen(config.port, () => {
  console.log(`SaaS bot backend listening on port ${config.port}`);
});

// Start Meta token refresh cron-like job
scheduleMetaTokenRefreshJob();

// NEW: Start booking reminder job
scheduleBookingReminderJob();

// NEW: Start Shopify data cleanup job
scheduleShopifyDataCleanupJob();
