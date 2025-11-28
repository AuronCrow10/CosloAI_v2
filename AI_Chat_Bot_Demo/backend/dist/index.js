"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const auth_1 = __importDefault(require("./routes/auth"));
const bots_1 = __importDefault(require("./routes/bots"));
const botChannel_1 = __importDefault(require("./routes/botChannel"));
const botKnowledge_1 = __importDefault(require("./routes/botKnowledge"));
const billing_1 = __importDefault(require("./routes/billing"));
const chat_1 = __importDefault(require("./routes/chat"));
const whatsappWebhook_1 = __importDefault(require("./routes/whatsappWebhook"));
const metaWebhook_1 = __importDefault(require("./routes/metaWebhook"));
const stripeWebhook_1 = require("./routes/stripeWebhook");
const conversations_1 = __importDefault(require("./routes/conversations"));
const metaAuth_1 = __importDefault(require("./routes/metaAuth"));
const metaTokenService_1 = require("./services/metaTokenService");
const app = (0, express_1.default)();
// Stripe webhook uses raw body; mount BEFORE json middleware
app.post("/stripe/webhook", express_1.default.raw({ type: "application/json" }), stripeWebhook_1.stripeWebhookHandler);
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_ORIGIN || "*",
    credentials: true
}));
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});
// Auth & SaaS routes
app.use("/auth", auth_1.default);
app.use("/api", bots_1.default);
app.use("/api", botChannel_1.default);
app.use("/api", botKnowledge_1.default);
app.use("/api", billing_1.default);
app.use("/api", conversations_1.default);
app.use("/api", metaAuth_1.default); // ⬅️ HERE
// Chat & webhooks
app.use("/api", chat_1.default);
app.use("/webhook/whatsapp", whatsappWebhook_1.default);
app.use("/webhook/meta", metaWebhook_1.default);
// If you serve static frontend from this service:
const publicDir = path_1.default.join(__dirname, "..", "public");
app.use(express_1.default.static(publicDir));
// 404 for unknown API
app.use("/api/*", (_req, res) => {
    res.status(404).json({ error: "Not found" });
});
app.get("*", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "index.html"));
});
// Error handler
app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});
app.listen(config_1.config.port, () => {
    console.log(`SaaS bot backend listening on port ${config_1.config.port}`);
});
// Start Meta token refresh cron-like job
(0, metaTokenService_1.scheduleMetaTokenRefreshJob)();
