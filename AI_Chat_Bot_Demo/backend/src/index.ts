// index.ts

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";

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
import referralsRouter from "./routes/referrals";
// NEW: booking reminder scheduler
import { scheduleBookingReminderJob } from "./services/bookingReminderService";

const app = express();

// IMPORTANT behind proxies (Render/Fly/Nginx/Cloudflare)
app.set("trust proxy", 1);

// Stripe webhook uses raw body; mount BEFORE json middleware
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }) as any,
  stripeWebhookHandler
);

app.use(express.json());
app.use(cookieParser());

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

// ✅ Referrals (NEW)
app.use("/api", referralsRouter);

// Chat & webhooks
app.use("/api", chatRouter);
app.use("/webhook/whatsapp", whatsappWebhookRouter);
app.use("/webhook/meta", metaWebhookRouter);

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

app.listen(config.port, () => {
  console.log(`SaaS bot backend listening on port ${config.port}`);
});

// Start Meta token refresh cron-like job
scheduleMetaTokenRefreshJob();

// NEW: Start booking reminder job
scheduleBookingReminderJob();
