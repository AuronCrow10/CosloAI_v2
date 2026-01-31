// src/routes/metaWebhook.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import util from "node:util";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import {
  refreshPageAccessTokenForChannel,
  isMetaTokenErrorNeedingRefresh
} from "../services/metaTokenService";
import { findOrCreateConversation, logMessage, HUMAN_HANDOFF_MESSAGE, shouldSwitchToHumanMode } from "../services/conversationService";
import { generateBotReplyForSlug } from "../services/chatService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "../services/rateLimitService";
import { handleMetaLeadgen } from "../services/metaLeadService";
import { getShopForBotId } from "../shopify/shopService";
import { createTrackingToken } from "../shopify/analyticsService";

import { ConversationMode } from "@prisma/client";

import type { Server as SocketIOServer } from "socket.io";
import { sendHumanConversationPush } from "../services/pushNotificationService";


function emitConversationMessages(
  io: SocketIOServer | undefined,
  ownerUserId: string | null,
  convoId: string,
  botId: string,
  ...messages: any[]
) {
  if (!io || !ownerUserId) return;
  for (const m of messages) {
    if (!m) continue;
    io.to(`user:${ownerUserId}`).emit("conversation:messageCreated", {
      conversationId: convoId,
      botId,
      message: m
    });
  }
}

const router = Router();

/** -----------------------------
 *  Readable “review” logger
 *  ----------------------------- */
type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_WEIGHT: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

const LOG_LEVEL = ((process.env.LOG_LEVEL || "INFO").toUpperCase() as Level) || "INFO";

function ts() {
  return new Date().toISOString();
}

function shortId(v: unknown, keepStart = 6, keepEnd = 4) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.length <= keepStart + keepEnd + 3) return s;
  return `${s.slice(0, keepStart)}…${s.slice(-keepEnd)}`;
}

function safeSnippet(text: string, maxLen = 90) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const cut = oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
  return cut;
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (typeof v === "string") {
    // Quote only if it has spaces / special chars
    const needsQuotes = /[\s"=|]/.test(v);
    return needsQuotes ? JSON.stringify(v) : v;
  }

  // Keep objects compact (only used in error detail lines)
  return util.inspect(v, { depth: 2, breakLength: 160, compact: true });
}

function fmtCtx(ctx: Record<string, unknown>) {
  const entries = Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, v] as const);

  // Sort keys for consistent reading
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  return entries.map(([k, v]) => `${k}=${formatVal(v)}`).join(" ");
}

function logLine(
  level: Level,
  src: "META" | "WA",
  msg: string,
  ctx: Record<string, unknown> = {}
) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[LOG_LEVEL]) return;

  const line =
    `${ts()} | ${level.padEnd(5)} | ${src.padEnd(4)} | ${msg.padEnd(28)} | ` +
    fmtCtx(ctx);

  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

function getRequestId(req: Request) {
  const existing =
    (req.headers["x-request-id"] as string | undefined) ||
    (req.headers["x-correlation-id"] as string | undefined);
  return existing || crypto.randomUUID();
}

function verifyMetaSignature(req: Request): boolean {
  const secret = config.metaAppSecret;
  if (!secret) return false;

  const signature = req.header("x-hub-signature-256");
  if (!signature || !signature.startsWith("sha256=")) return false;

  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody || rawBody.length === 0) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

function normalizeAxiosError(err: unknown) {
  if (!axios.isAxiosError(err)) return { status: undefined, data: err };
  return {
    status: err.response?.status,
    data: err.response?.data ?? err.message
  };
}

function extractMetaMessageId(data: unknown): string | undefined {
  const d: any = data;
  return d?.message_id || d?.messageId || d?.messages?.[0]?.id || d?.id;
}

type MetaButton = {
  type: "web_url";
  title: string;
  url: string;
};

type TrackingContext = {
  shopDomain: string;
  botId: string;
  conversationId?: string | null;
  baseUrl: string;
};

type UiLang = "it" | "es" | "en";

function detectUiLanguage(text: string): UiLang {
  const lower = text.trim().toLowerCase();
  if (!lower) return "en";

  const itSignals = ["ciao", "avete", "grazie", "vorrei", "voglio", "carrello"];
  if (itSignals.some((s) => lower.includes(s))) return "it";

  const esSignals = ["hola", "gracias", "quiero", "carrito", "por favor"];
  if (esSignals.some((s) => lower.includes(s))) return "es";

  return "en";
}

function buttonLabel(kind: "view" | "add", lang: UiLang): string {
  if (lang === "it") {
    return kind === "view" ? "Vedi prodotto" : "Aggiungi al carrello";
  }
  if (lang === "es") {
    return kind === "view" ? "Ver producto" : "Agregar al carrito";
  }
  return kind === "view" ? "View product" : "Add to cart";
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/gi) || [];
  return matches.map((raw) => raw.replace(/[).,!?]+$/g, ""));
}

function parseImageSegments(text: string): Array<{
  caption: string;
  imageUrl: string;
  textBefore: string;
}> {
  const regex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi;
  const segments: Array<{
    caption: string;
    imageUrl: string;
    textBefore: string;
  }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    const localBlock =
      before.split(/\n\s*\n/).filter(Boolean).pop() || before;
    const altText = (match[1] || "").trim();
    const imageUrl = match[2];
    const lines = localBlock
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const caption = altText || "Product";
    segments.push({ caption, imageUrl, textBefore: localBlock });
    lastIndex = regex.lastIndex;
  }

  return segments;
}

function stripImageMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, "$1");
}

function stripActionLines(text: string): string {
  const lines = text.split("\n");
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\[.+\]\(https?:\/\/[^)]+\)$/.test(trimmed)) return false;
    if (/^https?:\/\/\S+$/.test(trimmed)) return false;
    if (
      /^(view product|add to cart|vedi prodotto|aggiungi al carrello|ver producto|agregar al carrito)$/i.test(
        trimmed
      )
    ) {
      return false;
    }
    return true;
  });
  return cleaned.join("\n");
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

function extractActionUrls(reply: string): {
  productUrl: string | null;
  addToCartUrl: string | null;
} {
  const urls = extractUrls(reply);
  const productUrl = urls.find((u) => /\/products\//i.test(u)) || null;
  const addToCartUrl = urls.find((u) => /\/cart\/add/i.test(u)) || null;
  return { productUrl, addToCartUrl };
}

function buildTrackedUrl(
  ctx: TrackingContext | null,
  eventType: "view_product" | "add_to_cart",
  targetUrl: string | null
): string | null {
  if (!ctx || !targetUrl) return targetUrl;
  try {
    const url = new URL("/api/shopify/track", ctx.baseUrl);
    url.searchParams.set("shop", ctx.shopDomain);
    url.searchParams.set("botId", ctx.botId);
    url.searchParams.set("event", eventType);
    url.searchParams.set("target", targetUrl);
    if (ctx.conversationId) {
      url.searchParams.set("conversationId", ctx.conversationId);
    }
    const token = createTrackingToken({
      shopDomain: ctx.shopDomain,
      botId: ctx.botId,
      eventType,
      targetUrl,
      conversationId: ctx.conversationId ?? null
    });
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return targetUrl;
  }
}

function buildActionButtons(
  reply: string,
  lang: UiLang,
  tracking: TrackingContext | null
): {
  buttons: MetaButton[];
  templateText: string;
  productUrl: string | null;
  addToCartUrl: string | null;
} {
  const { productUrl, addToCartUrl } = extractActionUrls(reply);
  if (!productUrl && !addToCartUrl) {
    return { buttons: [], templateText: reply, productUrl, addToCartUrl };
  }

  const buttons: MetaButton[] = [];
  if (productUrl) {
    buttons.push({
      type: "web_url",
      title: buttonLabel("view", lang),
      url: buildTrackedUrl(tracking, "view_product", productUrl) || productUrl
    });
  }
  if (addToCartUrl) {
    buttons.push({
      type: "web_url",
      title: buttonLabel("add", lang),
      url:
        buildTrackedUrl(tracking, "add_to_cart", addToCartUrl) ||
        addToCartUrl
    });
  }

  const fallbackText = stripUrls(stripMarkdownLinks(stripActionLines(reply)));
  const templateText =
    (fallbackText || "Open one of the actions below.").slice(0, 600);

  return {
    buttons: buttons.slice(0, 3),
    templateText,
    productUrl,
    addToCartUrl
  };
}

type SendReplyResult =
  | {
      ok: true;
      attempt: 1 | 2;
      refreshedToken: boolean;
      status?: number;
      metaMessageId?: string;
    }
  | {
      ok: false;
      attempt: 1 | 2;
      refreshedToken: boolean;
      status?: number;
      reason:
        | "CHANNEL_NOT_FOUND"
        | "CONFIG_MISSING"
        | "REQUEST_FAILED"
        | "TOKEN_REFRESH_FAILED";
    };

/**
 * Shared FB/IG send wrapper using channel's access token + refresh logic.
 */
export async function sendGraphText(
  requestId: string,
  platform: "FB" | "IG",
  channelId: string,
  graphTargetId: string, // pageId or igBusinessId (or pageId for IG via FB Login)
  userId: string,
  reply: string,
  options?: { botId?: string; conversationId?: string | null }
): Promise<SendReplyResult> {
  const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
  if (!channel) {
    logLine("ERROR", "META", "reply failed (no channel)", {
      req: requestId,
      channel: channelId
    });
    return {
      ok: false,
      attempt: 1,
      refreshedToken: false,
      reason: "CHANNEL_NOT_FOUND"
    };
  }

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken || !config.metaGraphApiBaseUrl) {
    logLine("ERROR", "META", "reply failed (config)", {
      req: requestId,
      channel: channelId,
      hasToken: Boolean(accessToken),
      hasBaseUrl: Boolean(config.metaGraphApiBaseUrl)
    });
    return {
      ok: false,
      attempt: 1,
      refreshedToken: false,
      reason: "CONFIG_MISSING"
    };
  }

  const url = `${config.metaGraphApiBaseUrl}/${graphTargetId}/messages`;
  const trackingBase = config.shopifyAppUrl || process.env.FRONTEND_ORIGIN || "";
  const trackingContext =
    options?.botId && trackingBase
      ? await getShopForBotId(options.botId).then((shop) =>
          shop?.shopDomain
            ? {
                shopDomain: shop.shopDomain,
                botId: options.botId!,
                conversationId: options.conversationId ?? null,
                baseUrl: trackingBase
              }
            : null
        )
      : null;
  const imageSegments = parseImageSegments(reply);
  const replySansImagesRaw = stripImageMarkdown(reply);
  const lang = detectUiLanguage(
    stripMarkdownLinks(stripActionLines(replySansImagesRaw))
  );
  const {
    buttons,
    templateText,
    productUrl: globalProductUrl,
    addToCartUrl: globalAddToCartUrl
  } = buildActionButtons(replySansImagesRaw, lang, trackingContext);
  const replyText =
    stripUrls(stripMarkdownLinks(stripActionLines(replySansImagesRaw))) ||
    replySansImagesRaw ||
    reply;
  const textBody = {
    messaging_type: "RESPONSE",
    recipient: { id: userId },
    message: { text: replyText }
  };

  const genericTemplateBody =
    imageSegments.length > 0
      ? {
          messaging_type: "RESPONSE",
          recipient: { id: userId },
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "generic",
                elements: imageSegments.slice(0, 10).map((seg) => {
                  const segTail = seg.textBefore
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .slice(-4)
                    .join("\n");
                  const segUrls = extractActionUrls(segTail);
                  const productUrl = segUrls.productUrl || globalProductUrl;
                  const addToCartUrl =
                    segUrls.addToCartUrl || globalAddToCartUrl;

                  const segTextClean = stripUrls(
                    stripMarkdownLinks(stripActionLines(segTail))
                  );
                  const segLines = segTextClean
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);
                  const title =
                    segLines.length > 0
                      ? segLines[segLines.length - 1].slice(0, 80)
                      : seg.caption.slice(0, 80);
                  const subtitleSource =
                    segLines.length > 1
                      ? segLines.slice(0, segLines.length - 1).join(" ")
                      : segTextClean;
                  const subtitle = subtitleSource.slice(0, 80);

                  const elementButtons: MetaButton[] = [];
                  if (productUrl) {
                    elementButtons.push({
                      type: "web_url",
                      title: buttonLabel("view", lang),
                      url:
                        buildTrackedUrl(trackingContext, "view_product", productUrl) ||
                        productUrl
                    });
                  }
                  if (addToCartUrl) {
                    elementButtons.push({
                      type: "web_url",
                      title: buttonLabel("add", lang),
                      url:
                        buildTrackedUrl(trackingContext, "add_to_cart", addToCartUrl) ||
                        addToCartUrl
                    });
                  }

                  return {
                    title: title || "Product",
                    subtitle: subtitle || undefined,
                    image_url: seg.imageUrl,
                    buttons: elementButtons.slice(0, 3)
                  };
                })
              }
            }
          }
        }
      : null;

  const buttonBody =
    buttons.length > 0 && imageSegments.length === 0
      ? {
          messaging_type: "RESPONSE",
          recipient: { id: userId },
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "button",
                text: templateText,
                buttons
              }
            }
          }
        }
      : null;

  // Attempt 1
  try {
    const primaryBody = genericTemplateBody || buttonBody || textBody;
    const resp = await axios.post(url, primaryBody, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    const result: SendReplyResult = {
      ok: true,
      attempt: 1,
      refreshedToken: false,
      status: resp.status,
      metaMessageId: extractMetaMessageId(resp.data)
    };

    return result;
  } catch (err: unknown) {
    const n = normalizeAxiosError(err);

    logLine("WARN", "META", "reply send failed", {
      req: requestId,
      plat: platform,
      channel: channelId,
      target: shortId(graphTargetId),
      user: shortId(userId),
      status: n.status
    });
    logLine("DEBUG", "META", "reply send failed details", {
      req: requestId,
      details: n.data
    });

    if (!isMetaTokenErrorNeedingRefresh(err)) {
      // Button templates can fail for some surfaces; fall back to plain text.
      if (genericTemplateBody || buttonBody) {
        try {
          const respFallback = await axios.post(url, textBody, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            timeout: 10000
          });

          logLine("WARN", "META", "template send failed, fell back to text", {
            req: requestId,
            plat: platform,
            channel: channelId,
            status: n.status
          });

          const result: SendReplyResult = {
            ok: true,
            attempt: 1,
            refreshedToken: false,
            status: respFallback.status,
            metaMessageId: extractMetaMessageId(respFallback.data)
          };

          return result;
        } catch {
          // ignore and return the original error below
        }
      }

      return {
        ok: false,
        attempt: 1,
        refreshedToken: false,
        status: n.status,
        reason: "REQUEST_FAILED"
      };
    }

    // Refresh + attempt 2
    logLine("INFO", "META", "refresh token", {
      req: requestId,
      channel: channelId
    });

    const refreshed = await refreshPageAccessTokenForChannel(channelId);
    if (!refreshed?.accessToken) {
      logLine("ERROR", "META", "refresh token failed", {
        req: requestId,
        channel: channelId
      });
      return {
        ok: false,
        attempt: 2,
        refreshedToken: true,
        status: n.status,
        reason: "TOKEN_REFRESH_FAILED"
      };
    }

    accessToken = refreshed.accessToken;

    try {
      const primaryBody = genericTemplateBody || buttonBody || textBody;
      const resp2 = await axios.post(url, primaryBody, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      });

      logLine("INFO", "META", "refresh token ok", {
        req: requestId,
        channel: channelId
      });

      const result: SendReplyResult = {
        ok: true,
        attempt: 2,
        refreshedToken: true,
        status: resp2.status,
        metaMessageId: extractMetaMessageId(resp2.data)
      };

      return result;
    } catch (err2: unknown) {
      const n2 = normalizeAxiosError(err2);
      if (genericTemplateBody || buttonBody) {
        try {
          const respFallback2 = await axios.post(url, textBody, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            timeout: 10000
          });

          logLine("WARN", "META", "template send failed after refresh, fell back to text", {
            req: requestId,
            plat: platform,
            channel: channelId,
            status: n2.status
          });

          const result: SendReplyResult = {
            ok: true,
            attempt: 2,
            refreshedToken: true,
            status: respFallback2.status,
            metaMessageId: extractMetaMessageId(respFallback2.data)
          };

          return result;
        } catch {
          // ignore and return the error below
        }
      }
      logLine("ERROR", "META", "reply failed after refresh", {
        req: requestId,
        plat: platform,
        channel: channelId,
        status: n2.status
      });
      logLine("DEBUG", "META", "reply failed after refresh details", {
        req: requestId,
        details: n2.data
      });

      return {
        ok: false,
        attempt: 2,
        refreshedToken: true,
        status: n2.status,
        reason: "REQUEST_FAILED"
      };
    }
  }
}

// GET /webhook/meta (verification)
router.get("/", (req: Request, res: Response) => {
  const requestId = getRequestId(req);

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token === config.metaVerifyToken;

  logLine(ok ? "INFO" : "WARN", "META", "verify", {
    req: requestId,
    mode,
    verified: ok
  });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// POST /webhook/meta
router.post("/", async (req: Request, res: Response) => {
  const requestId = getRequestId(req);
  const startedAt = Date.now();

  if (!config.metaAppSecret) {
    logLine("ERROR", "META", "missing app secret", { req: requestId });
    return res.sendStatus(500);
  }

  if (!verifyMetaSignature(req)) {
    logLine("WARN", "META", "invalid signature", { req: requestId });
    return res.sendStatus(401);
  }

  const body: unknown = req.body;
  const objectType =
    typeof (body as any)?.object === "string" ? (body as any).object : "unknown";
  const entryCount = Array.isArray((body as any)?.entry)
    ? (body as any).entry.length
    : 0;

  logLine("INFO", "META", "⇢ webhook received", {
    req: requestId,
    object: objectType,
    entries: entryCount
  });

  if (!body || typeof body !== "object" || !(body as any).object) {
    logLine("DEBUG", "META", "ignored", {
      req: requestId,
      reason: "missing body/object"
    });
    return res.sendStatus(200);
  }

  try {
    // -----------------------------
    // 1) Facebook PAGE messages + leadgen
    // -----------------------------
    if ((body as any).object === "page") {
      const entries = Array.isArray((body as any).entry)
        ? (body as any).entry
        : [];

      for (const entry of entries) {
        const pageId: string | undefined = entry?.id;
        const messagingEvents = Array.isArray(entry?.messaging)
          ? entry.messaging
          : [];

        // 1.1) Messaging events
        for (const event of messagingEvents) {
          const message = event?.message;
          const sender = event?.sender;

          const text: string | undefined = message?.text;
          const userId: string | undefined = sender?.id;
          const mid: string | undefined = message?.mid;

          if (!pageId || !userId) continue;

          if (!message || !text) {
            logLine("DEBUG", "META", "ignored (non-text)", {
              req: requestId,
              plat: "FB",
              page: shortId(pageId),
              user: shortId(userId),
              mid: shortId(mid)
            });
            continue;
          }

          logLine("INFO", "META", "message received", {
            req: requestId,
            plat: "FB",
            page: shortId(pageId),
            user: shortId(userId),
            mid: shortId(mid),
            text: safeSnippet(text)
          });

          const channel = await prisma.botChannel.findFirst({
            where: { type: "FACEBOOK", externalId: pageId },
            include: { bot: true }
          });

          if (!channel?.bot) {
            logLine("WARN", "META", "unlinked pageId", {
              req: requestId,
              plat: "FB",
              page: shortId(pageId),
              user: shortId(userId),
              mid: shortId(mid)
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            logLine("WARN", "META", "bot inactive", {
              req: requestId,
              bot: bot.slug,
              status: bot.status
            });
            continue;
          }

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "FACEBOOK",
            externalUserId: userId
          });

          logLine("INFO", "META", "conversation resolved", {
            req: requestId,
            bot: bot.slug,
            convo: convo.id,
            channel: channel.id
          });

          const wantsHuman = shouldSwitchToHumanMode(text);

if (wantsHuman && convo.mode !== ConversationMode.HUMAN) {
  const updated = await prisma.conversation.update({
    where: { id: convo.id },
    data: { mode: ConversationMode.HUMAN }
  });

  const io = req.app.get("io") as SocketIOServer | undefined;

  try {
    const userMsg = await logMessage({
      conversationId: convo.id,
      role: "USER",
      content: text,
      channelMessageId: mid
    });
    const assistantMsg = await logMessage({
      conversationId: convo.id,
      role: "ASSISTANT",
      content: HUMAN_HANDOFF_MESSAGE
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
  } catch (e: unknown) {
    logLine("ERROR", "META", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "db log failed details", {
      req: requestId,
      details: e
    });
  }

  const send = await sendGraphText(
    requestId,
    "FB",
    channel.id,
    pageId,
    userId,
    HUMAN_HANDOFF_MESSAGE,
    { botId: bot.id, conversationId: convo.id }
  );

  logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
    req: requestId,
    plat: "FB",
    type: "HUMAN_HANDOFF",
    status: send.status,
    metaMsgId: shortId(send.ok ? send.metaMessageId : undefined),
    attempt: send.attempt,
    refreshed: send.refreshedToken
  });

  // 🔴 NEW: notify mobile clients via Socket.IO
  try {
    const io = req.app.get("io") as SocketIOServer | undefined;

    if (io && bot.userId) {
      const now = new Date();
      io.to(`user:${bot.userId}`).emit("conversation:modeChanged", {
        conversationId: convo.id,
        botId: convo.botId,
        mode: updated.mode,
        channel: convo.channel,
        lastMessageAt: now,
        lastUserMessageAt: now
      });
    }
  } catch (err) {
    logLine("ERROR", "META", "socket emit failed (FB handoff)", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "socket emit failed details", {
      req: requestId,
      details: err
    });
  }

            try {
              await sendHumanConversationPush(bot.userId, {
                conversationId: convo.id,
                botId: bot.id,
                botName: bot.name,
                channel: "FACEBOOK"
              });
            } catch (pushErr) {
              logLine("ERROR", "META", "push send failed", {
                req: requestId,
                plat: "FB",
                convo: convo.id,
                error: (pushErr as Error).message
              });
            }

  continue;
}

          if (convo.mode === ConversationMode.HUMAN) {
  const io = req.app.get("io") as SocketIOServer | undefined;

  try {
    const userMsg = await logMessage({
      conversationId: convo.id,
      role: "USER",
      content: text,
      channelMessageId: mid
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg);
  } catch (e: unknown) {
    logLine("ERROR", "META", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "db log failed details", {
      req: requestId,
      details: e
    });
  }

  logLine("INFO", "META", "human handoff active, skipping bot reply", {
    req: requestId,
    convo: convo.id
  });

  continue;
}
          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(
              rateResult.retryAfterSeconds
            );

            logLine("WARN", "META", "rate limited", {
              req: requestId,
              convo: convo.id,
              retryAfter: rateResult.retryAfterSeconds
            });

            const io = req.app.get("io") as SocketIOServer | undefined;

  try {
    const userMsg = await logMessage({
      conversationId: convo.id,
      role: "USER",
      content: text,
      channelMessageId: mid
    });
    const assistantMsg = await logMessage({
      conversationId: convo.id,
      role: "ASSISTANT",
      content: rateMessage
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
  } catch (e: unknown) {
    logLine("ERROR", "META", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "db log failed details", {
      req: requestId,
      details: e
    });
  }

            const send = await sendGraphText(
              requestId,
              "FB",
              channel.id,
              pageId,
              userId,
              rateMessage,
              { botId: bot.id, conversationId: convo.id }
            );

            logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
              req: requestId,
              plat: "FB",
              type: "RATE_LIMIT",
              status: send.status,
              metaMsgId: shortId(
                send.ok ? send.metaMessageId : undefined
              ),
              attempt: send.attempt,
              refreshed: send.refreshedToken
            });

            continue;
          }

          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, {
            conversationId: convo.id
          });
          const chatMs = Date.now() - t0;
  const replyForLog =
    stripUrls(stripMarkdownLinks(stripImageMarkdown(reply))) ||
    stripImageMarkdown(reply) ||
    reply;

          logLine("INFO", "META", "reply generated", {
            req: requestId,
            convo: convo.id,
            ms: chatMs,
            reply: safeSnippet(replyForLog)
          });

          const io = req.app.get("io") as SocketIOServer | undefined;

try {
  const userMsg = await logMessage({
    conversationId: convo.id,
    role: "USER",
    content: text,
    channelMessageId: mid
  });
  const assistantMsg = await logMessage({
    conversationId: convo.id,
    role: "ASSISTANT",
    content: replyForLog
  });

  emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
} catch (e: unknown) {
  logLine("ERROR", "META", "db log failed", {
    req: requestId,
    convo: convo.id
  });
  logLine("DEBUG", "META", "db log failed details", {
    req: requestId,
    details: e
  });
}

          const send = await sendGraphText(
            requestId,
            "FB",
            channel.id,
            pageId,
            userId,
            reply,
            { botId: bot.id, conversationId: convo.id }
          );

          logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
            req: requestId,
            plat: "FB",
            type: "NORMAL",
            status: send.status,
            metaMsgId: shortId(
              send.ok ? send.metaMessageId : undefined
            ),
            attempt: send.attempt,
            refreshed: send.refreshedToken
          });
        }

        // 1.2) Leadgen changes (same entry)
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          if (change?.field !== "leadgen") {
            continue;
          }

          const value = change?.value;
          const leadgenId: string | undefined = value?.leadgen_id;
          const formId: string | undefined = value?.form_id;
          const createdTime: string | undefined = value?.created_time;

          if (!pageId || !leadgenId) {
            logLine("WARN", "META", "leadgen missing ids", {
              req: requestId,
              page: shortId(pageId),
              lead: shortId(leadgenId)
            });
            continue;
          }

          logLine("INFO", "META", "leadgen received", {
            req: requestId,
            page: shortId(pageId),
            lead: shortId(leadgenId),
            form: shortId(formId),
            created: createdTime
          });

          await handleMetaLeadgen(requestId, pageId, leadgenId, formId);
        }
      }

      // -----------------------------
      // 2) Instagram messages
      // -----------------------------
    } else if ((body as any).object === "instagram") {
      const entries = Array.isArray((body as any).entry)
        ? (body as any).entry
        : [];

      for (const entry of entries) {
        const igBusinessId: string | undefined = entry?.id;
        const messagingEvents = Array.isArray(entry?.messaging)
          ? entry.messaging
          : [];

        for (const event of messagingEvents) {
          const message = event?.message;
          const sender = event?.sender;

          const text: string | undefined = message?.text;
          const userId: string | undefined = sender?.id;
          const mid: string | undefined = message?.mid;

          if (!igBusinessId || !userId) continue;

          if (userId === igBusinessId) {
          // These are echoes of messages we (the page/bot) sent; we already log
          // assistant messages ourselves and don't want a separate "self" convo.
            logLine("DEBUG", "META", "ignored (IG business message)", {
              req: requestId,
              plat: "IG",
              ig: shortId(igBusinessId),
              user: shortId(userId),
              mid: shortId(mid)
            });
            continue;
          }

          if (!message || !text) {
            logLine("DEBUG", "META", "ignored (non-text)", {
              req: requestId,
              plat: "IG",
              ig: shortId(igBusinessId),
              user: shortId(userId),
              mid: shortId(mid)
            });
            continue;
          }

          logLine("INFO", "META", "message received", {
            req: requestId,
            plat: "IG",
            ig: shortId(igBusinessId),
            user: shortId(userId),
            mid: shortId(mid),
            text: safeSnippet(text)
          });

          const channel = await prisma.botChannel.findFirst({
            where: { type: "INSTAGRAM", externalId: igBusinessId },
            include: { bot: true }
          });

          if (!channel?.bot) {
            logLine("WARN", "META", "unlinked igBusinessId", {
              req: requestId,
              plat: "IG",
              ig: shortId(igBusinessId),
              user: shortId(userId),
              mid: shortId(mid)
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            logLine("WARN", "META", "bot inactive", {
              req: requestId,
              bot: bot.slug,
              status: bot.status
            });
            continue;
          }

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "INSTAGRAM",
            externalUserId: userId
          });

          logLine("INFO", "META", "conversation resolved", {
            req: requestId,
            bot: bot.slug,
            convo: convo.id,
            channel: channel.id
          });

          const meta = (channel.meta as any) || {};
          // For Instagram via Facebook Login, replies must be sent via the PAGE ID
          const graphTargetId: string = meta.pageId || igBusinessId;

const wantsHuman = shouldSwitchToHumanMode(text);

if (wantsHuman && convo.mode !== ConversationMode.HUMAN) {
  const updated = await prisma.conversation.update({
    where: { id: convo.id },
    data: { mode: ConversationMode.HUMAN }
  });

  const io = req.app.get("io") as SocketIOServer | undefined;

  try {
    const userMsg = await logMessage({
      conversationId: convo.id,
      role: "USER",
      content: text,
      channelMessageId: mid
    });
    const assistantMsg = await logMessage({
      conversationId: convo.id,
      role: "ASSISTANT",
      content: HUMAN_HANDOFF_MESSAGE
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
  } catch (e: unknown) {
    logLine("ERROR", "META", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "db log failed details", {
      req: requestId,
      details: e
    });
  }

  const send = await sendGraphText(
    requestId,
    "IG",
    channel.id,
    graphTargetId,
    userId,
    HUMAN_HANDOFF_MESSAGE,
    { botId: bot.id, conversationId: convo.id }
  );

  logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
    req: requestId,
    plat: "IG",
    type: "HUMAN_HANDOFF",
    status: send.status,
    metaMsgId: shortId(send.ok ? send.metaMessageId : undefined),
    attempt: send.attempt,
    refreshed: send.refreshedToken
  });

  // 🔴 NEW: Socket.IO emit
  try {
    const io = req.app.get("io") as SocketIOServer | undefined;

    if (io && bot.userId) {
      const now = new Date();
      io.to(`user:${bot.userId}`).emit("conversation:modeChanged", {
        conversationId: convo.id,
        botId: convo.botId,
        mode: updated.mode,
        channel: convo.channel,
        lastMessageAt: now,
        lastUserMessageAt: now
      });
    }
  } catch (err) {
    logLine("ERROR", "META", "socket emit failed (IG handoff)", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "socket emit failed details", {
      req: requestId,
      details: err
    });
  }

            try {
              await sendHumanConversationPush(bot.userId, {
                conversationId: convo.id,
                botId: bot.id,
                botName: bot.name,
                channel: "INSTAGRAM"
              });
            } catch (pushErr) {
              logLine("ERROR", "META", "push send failed", {
                req: requestId,
                plat: "IG",
                convo: convo.id,
                error: (pushErr as Error).message
              });
            }

  continue;
}


          if (convo.mode === ConversationMode.HUMAN) {
  const io = req.app.get("io") as SocketIOServer | undefined;

  try {
    const userMsg = await logMessage({
      conversationId: convo.id,
      role: "USER",
      content: text,
      channelMessageId: mid
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg);
  } catch (e: unknown) {
    logLine("ERROR", "META", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "db log failed details", {
      req: requestId,
      details: e
    });
  }

  logLine("INFO", "META", "human handoff active, skipping bot reply", {
    req: requestId,
    convo: convo.id
  });

  continue;
}

          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(
              rateResult.retryAfterSeconds
            );

            logLine("WARN", "META", "rate limited", {
              req: requestId,
              convo: convo.id,
              retryAfter: rateResult.retryAfterSeconds
            });

            const io = req.app.get("io") as SocketIOServer | undefined;

  try {
    const userMsg = await logMessage({
      conversationId: convo.id,
      role: "USER",
      content: text,
      channelMessageId: mid
    });
    const assistantMsg = await logMessage({
      conversationId: convo.id,
      role: "ASSISTANT",
      content: rateMessage
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
  } catch (e: unknown) {
    logLine("ERROR", "META", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "META", "db log failed details", {
      req: requestId,
      details: e
    });
  }
            const send = await sendGraphText(
              requestId,
              "IG",
              channel.id,
              graphTargetId,
              userId,
              rateMessage,
              { botId: bot.id, conversationId: convo.id }
            );

            logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
              req: requestId,
              plat: "IG",
              type: "RATE_LIMIT",
              status: send.status,
              metaMsgId: shortId(
                send.ok ? send.metaMessageId : undefined
              ),
              attempt: send.attempt,
              refreshed: send.refreshedToken
            });

            continue;
          }

          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, {
            conversationId: convo.id
          });
          const chatMs = Date.now() - t0;
  const replyForLog =
    stripUrls(stripMarkdownLinks(stripImageMarkdown(reply))) ||
    stripImageMarkdown(reply) ||
    reply;

          logLine("INFO", "META", "reply generated", {
            req: requestId,
            convo: convo.id,
            ms: chatMs,
            reply: safeSnippet(replyForLog)
          });

          const io = req.app.get("io") as SocketIOServer | undefined;

try {
  const userMsg = await logMessage({
    conversationId: convo.id,
    role: "USER",
    content: text,
    channelMessageId: mid
  });
  const assistantMsg = await logMessage({
    conversationId: convo.id,
    role: "ASSISTANT",
    content: replyForLog
  });

  emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
} catch (e: unknown) {
  logLine("ERROR", "META", "db log failed", {
    req: requestId,
    convo: convo.id
  });
  logLine("DEBUG", "META", "db log failed details", {
    req: requestId,
    details: e
  });
}

          const send = await sendGraphText(
            requestId,
            "IG",
            channel.id,
            graphTargetId,
            userId,
            reply,
            { botId: bot.id, conversationId: convo.id }
          );

          logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
            req: requestId,
            plat: "IG",
            type: "NORMAL",
            status: send.status,
            metaMsgId: shortId(
              send.ok ? send.metaMessageId : undefined
            ),
            attempt: send.attempt,
            refreshed: send.refreshedToken
          });
        }
      }
    } else {
      // Unsupported object
      logLine("INFO", "META", "ignored (unsupported)", {
        req: requestId,
        object: (body as any).object
      });
    }
  } catch (err: unknown) {
    // 🔴 NEW: full details at ERROR level so you see them with LOG_LEVEL=INFO
    const normalized = normalizeAxiosError(err);
    const base: any = {
      req: requestId,
      status: normalized.status
    };

    if (normalized.data !== undefined) {
      base.errorData = normalized.data;
    }

    if (err instanceof Error) {
      base.errorMessage = err.message;
      base.errorStack = err.stack;
      // name can also be useful
      base.errorName = err.name;
    } else {
      base.rawError = err;
    }

    logLine("ERROR", "META", "webhook error", base);
  }

  logLine("INFO", "META", "⇠ done", {
    req: requestId,
    ms: Date.now() - startedAt
  });

  return res.sendStatus(200);
});

export default router;
