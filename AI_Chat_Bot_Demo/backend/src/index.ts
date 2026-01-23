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

import referralsRouter from "./routes/referrals";
import adminUsersRouter from "./routes/adminUsers";
import adminBotsRouter from "./routes/adminBots";
import adminBookingsRouter from "./routes/adminBookings";
import adminEmailUsageRouter from "./routes/adminEmailUsage";
import adminPaymentsRouter from "./routes/adminPayments";
import adminOpenAIUsageRouter from "./routes/adminOpenAIUsage";
import adminIntegrationsRouter from "./routes/adminIntegrations";
import adminPlansRouter from "./routes/adminPlans";
// NEW: booking reminder scheduler
import { scheduleBookingReminderJob } from "./services/bookingReminderService";
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

// Security headers (CSP disabled here to avoid breaking existing UI)
const cspDirectives = {
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
    "https://accounts.google.com",
    "https://connect.facebook.net",
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
    "https://graph.facebook.com",
    "https://*.facebook.com",
    "wss:"
  ]
};

const cspReportOnly = process.env.CSP_REPORT_ONLY === "1";
const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  (cspDirectives as any).upgradeInsecureRequests = [];
}

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: cspDirectives,
      reportOnly: cspReportOnly
    }
  })
);

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
  cors({
    origin: (origin, cb) => {
      // Non-browser clients / same-origin requests might not send Origin
      if (!origin) return cb(null, true);

      if (allowedOrigins.length > 0) {
        return cb(null, allowedOrigins.includes(origin));
      }

      if (process.env.NODE_ENV !== "production") {
        // reflect any origin in dev
        return cb(null, true);
      }

      // prod: no CORS headers (same-origin expected)
      return cb(null, false);
    },
    credentials: true
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
