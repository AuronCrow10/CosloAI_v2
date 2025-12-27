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
import { findOrCreateConversation, logMessage } from "../services/conversationService";
import { generateBotReplyForSlug } from "../services/chatService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "../services/rateLimitService";
import { handleMetaLeadgen } from "../services/metaLeadService";

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

function logLine(level: Level, src: "META" | "WA", msg: string, ctx: Record<string, unknown> = {}) {
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

function normalizeAxiosError(err: unknown) {
  if (!axios.isAxiosError(err)) return { status: undefined, data: err };
  return { status: err.response?.status, data: err.response?.data ?? err.message };
}

function extractMetaMessageId(data: unknown): string | undefined {
  const d: any = data;
  return (
    d?.message_id ||
    d?.messageId ||
    d?.messages?.[0]?.id ||
    d?.id
  );
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

async function sendGraphText(
  requestId: string,
  platform: "FB" | "IG",
  channelId: string,
  graphTargetId: string, // pageId or igBusinessId
  userId: string,
  reply: string
): Promise<SendReplyResult> {
  const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
  if (!channel) {
    logLine("ERROR", "META", "reply failed (no channel)", { req: requestId, channel: channelId });
    return { ok: false, attempt: 1, refreshedToken: false, reason: "CHANNEL_NOT_FOUND" };
  }

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken || !config.metaGraphApiBaseUrl) {
    logLine("ERROR", "META", "reply failed (config)", {
      req: requestId,
      channel: channelId,
      hasToken: Boolean(accessToken),
      hasBaseUrl: Boolean(config.metaGraphApiBaseUrl)
    });
    return { ok: false, attempt: 1, refreshedToken: false, reason: "CONFIG_MISSING" };
  }

  const url = `${config.metaGraphApiBaseUrl}/${graphTargetId}/messages`;
  const body = {
    messaging_type: "RESPONSE",
    recipient: { id: userId },
    message: { text: reply }
  };

  // Attempt 1
  try {
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      timeout: 10000
    });

    return {
      ok: true,
      attempt: 1,
      refreshedToken: false,
      status: resp.status,
      metaMessageId: extractMetaMessageId(resp.data)
    };
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
      return {
        ok: false,
        attempt: 1,
        refreshedToken: false,
        status: n.status,
        reason: "REQUEST_FAILED"
      };
    }

    // Refresh + attempt 2
    logLine("INFO", "META", "refresh token", { req: requestId, channel: channelId });

    const refreshed = await refreshPageAccessTokenForChannel(channelId);
    if (!refreshed?.accessToken) {
      logLine("ERROR", "META", "refresh token failed", { req: requestId, channel: channelId });
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
      const resp2 = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        timeout: 10000
      });

      logLine("INFO", "META", "refresh token ok", { req: requestId, channel: channelId });

      return {
        ok: true,
        attempt: 2,
        refreshedToken: true,
        status: resp2.status,
        metaMessageId: extractMetaMessageId(resp2.data)
      };
    } catch (err2: unknown) {
      const n2 = normalizeAxiosError(err2);
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

  const body: unknown = req.body;
  const objectType = typeof (body as any)?.object === "string" ? (body as any).object : "unknown";
  const entryCount = Array.isArray((body as any)?.entry) ? (body as any).entry.length : 0;

  logLine("INFO", "META", "⇢ webhook received", {
    req: requestId,
    object: objectType,
    entries: entryCount
  });

  if (!body || typeof body !== "object" || !(body as any).object) {
    logLine("DEBUG", "META", "ignored", { req: requestId, reason: "missing body/object" });
    return res.sendStatus(200);
  }

  try {
    if ((body as any).object === "page") {
      const entries = Array.isArray((body as any).entry) ? (body as any).entry : [];

      for (const entry of entries) {
        const pageId: string | undefined = entry?.id;
        const messagingEvents = Array.isArray(entry?.messaging) ? entry.messaging : [];

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

          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            logLine("WARN", "META", "rate limited", {
              req: requestId,
              convo: convo.id,
              retryAfter: rateResult.retryAfterSeconds
            });

            try {
              await logMessage({
                conversationId: convo.id,
                role: "USER",
                content: text,
                channelMessageId: mid
              });
              await logMessage({
                conversationId: convo.id,
                role: "ASSISTANT",
                content: rateMessage
              });
            } catch (e: unknown) {
              logLine("ERROR", "META", "db log failed", { req: requestId, convo: convo.id });
              logLine("DEBUG", "META", "db log failed details", { req: requestId, details: e });
            }

            const send = await sendGraphText(requestId, "FB", channel.id, pageId, userId, rateMessage);

            logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
              req: requestId,
              plat: "FB",
              type: "RATE_LIMIT",
              status: send.status,
              metaMsgId: shortId(send.ok ? send.metaMessageId : undefined),
              attempt: send.attempt,
              refreshed: send.refreshedToken
            });

            continue;
          }

          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, { conversationId: convo.id });
          const chatMs = Date.now() - t0;

          logLine("INFO", "META", "reply generated", {
            req: requestId,
            convo: convo.id,
            ms: chatMs,
            reply: safeSnippet(reply)
          });

          try {
            await logMessage({
              conversationId: convo.id,
              role: "USER",
              content: text,
              channelMessageId: mid
            });
            await logMessage({
              conversationId: convo.id,
              role: "ASSISTANT",
              content: reply
            });
          } catch (e: unknown) {
            logLine("ERROR", "META", "db log failed", { req: requestId, convo: convo.id });
            logLine("DEBUG", "META", "db log failed details", { req: requestId, details: e });
          }

          const send = await sendGraphText(requestId, "FB", channel.id, pageId, userId, reply);

          logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
            req: requestId,
            plat: "FB",
            type: "NORMAL",
            status: send.status,
            metaMsgId: shortId(send.ok ? send.metaMessageId : undefined),
            attempt: send.attempt,
            refreshed: send.refreshedToken
          });
        }
        // 2) NEW: leadgen changes
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
    } else if ((body as any).object === "instagram") {
      const entries = Array.isArray((body as any).entry) ? (body as any).entry : [];

      for (const entry of entries) {
        const igBusinessId: string | undefined = entry?.id;
        const messagingEvents = Array.isArray(entry?.messaging) ? entry.messaging : [];

        for (const event of messagingEvents) {
          const message = event?.message;
          const sender = event?.sender;

          const text: string | undefined = message?.text;
          const userId: string | undefined = sender?.id;
          const mid: string | undefined = message?.mid;

          if (!igBusinessId || !userId) continue;

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

          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            logLine("WARN", "META", "rate limited", {
              req: requestId,
              convo: convo.id,
              retryAfter: rateResult.retryAfterSeconds
            });

            try {
              await logMessage({
                conversationId: convo.id,
                role: "USER",
                content: text,
                channelMessageId: mid
              });
              await logMessage({
                conversationId: convo.id,
                role: "ASSISTANT",
                content: rateMessage
              });
            } catch (e: unknown) {
              logLine("ERROR", "META", "db log failed", { req: requestId, convo: convo.id });
              logLine("DEBUG", "META", "db log failed details", { req: requestId, details: e });
            }

            const send = await sendGraphText(
              requestId,
              "IG",
              channel.id,
              graphTargetId,
              userId,
              rateMessage
            );

            logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
              req: requestId,
              plat: "IG",
              type: "RATE_LIMIT",
              status: send.status,
              metaMsgId: shortId(send.ok ? send.metaMessageId : undefined),
              attempt: send.attempt,
              refreshed: send.refreshedToken
            });

            continue;
          }

          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, { conversationId: convo.id });
          const chatMs = Date.now() - t0;

          logLine("INFO", "META", "reply generated", {
            req: requestId,
            convo: convo.id,
            ms: chatMs,
            reply: safeSnippet(reply)
          });

          try {
            await logMessage({
              conversationId: convo.id,
              role: "USER",
              content: text,
              channelMessageId: mid
            });
            await logMessage({
              conversationId: convo.id,
              role: "ASSISTANT",
              content: reply
            });
          } catch (e: unknown) {
            logLine("ERROR", "META", "db log failed", { req: requestId, convo: convo.id });
            logLine("DEBUG", "META", "db log failed details", { req: requestId, details: e });
          }

          const send = await sendGraphText(
            requestId,
            "IG",
            channel.id,
            graphTargetId,
            userId,
            reply
          );

          logLine(send.ok ? "INFO" : "ERROR", "META", "reply sent", {
            req: requestId,
            plat: "IG",
            type: "NORMAL",
            status: send.status,
            metaMsgId: shortId(send.ok ? send.metaMessageId : undefined),
            attempt: send.attempt,
            refreshed: send.refreshedToken
          });
        }
      }
    } else {
      logLine("INFO", "META", "ignored (unsupported)", {
        req: requestId,
        object: (body as any).object
      });
    }
  } catch (err: unknown) {
    logLine("ERROR", "META", "webhook error", { req: requestId });
    logLine("DEBUG", "META", "webhook error details", { req: requestId, details: err });
  }

  logLine("INFO", "META", "⇠ done", { req: requestId, ms: Date.now() - startedAt });

  return res.sendStatus(200);
});

export default router;
