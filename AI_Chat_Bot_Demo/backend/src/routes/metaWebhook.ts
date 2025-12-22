// src/routes/metaWebhook.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
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

const router = Router();

/**
 * Structured logging helpers (clean, review-friendly JSON logs).
 * These logs are meant to show:
 * - webhook received (with object + entry counts)
 * - message extracted (mid, sender, page/ig business id)
 * - bot/channel/conversation resolved
 * - reply generated
 * - reply sent to Meta Graph API (+ retry/refresh outcomes)
 */
type LogLevel = "debug" | "info" | "warn" | "error";

function nowIso() {
  return new Date().toISOString();
}

function safeSnippet(text: string, maxLen = 120) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

function logJson(
  level: LogLevel,
  event: string,
  data: Record<string, unknown> = {}
) {
  const payload = {
    ts: nowIso(),
    level,
    event,
    ...data
  };

  // Keep console method consistent with severity.
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function getRequestId(req: Request) {
  const existing =
    (req.headers["x-request-id"] as string | undefined) ||
    (req.headers["x-correlation-id"] as string | undefined);
  return existing || crypto.randomUUID();
}

type SendReplyResult =
  | {
      ok: true;
      attempt: 1 | 2;
      refreshedToken: boolean;
      status?: number;
      metaResponse?: unknown;
    }
  | {
      ok: false;
      attempt: 1 | 2;
      refreshedToken: boolean;
      status?: number;
      metaError?: unknown;
      reason:
        | "CHANNEL_NOT_FOUND"
        | "CONFIG_MISSING"
        | "REQUEST_FAILED"
        | "TOKEN_REFRESH_FAILED";
    };

function normalizeAxiosError(err: unknown) {
  if (!axios.isAxiosError(err)) {
    return { status: undefined, data: err };
  }
  return {
    status: err.response?.status,
    data: err.response?.data ?? err.message
  };
}

// GET /webhook/meta (verification)
router.get("/", (req: Request, res: Response) => {
  const requestId = getRequestId(req);

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token === config.metaVerifyToken;

  logJson(ok ? "info" : "warn", "meta.webhook.verify", {
    requestId,
    mode,
    tokenProvided: Boolean(token),
    challengeProvided: Boolean(challenge),
    verified: ok
  });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function sendFacebookReply(
  requestId: string,
  channelId: string,
  pageId: string,
  userId: string,
  reply: string
): Promise<SendReplyResult> {
  const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
  if (!channel) {
    logJson("error", "meta.reply.fb.channel_not_found", { requestId, channelId });
    return {
      ok: false,
      attempt: 1,
      refreshedToken: false,
      reason: "CHANNEL_NOT_FOUND"
    };
  }

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken || !config.metaGraphApiBaseUrl) {
    logJson("error", "meta.reply.fb.config_missing", {
      requestId,
      channelId,
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

  const url = `${config.metaGraphApiBaseUrl}/${pageId}/messages`;
  const body = {
    messaging_type: "RESPONSE",
    recipient: { id: userId },
    message: { text: reply }
  };

  // Attempt 1
  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    return {
      ok: true,
      attempt: 1,
      refreshedToken: false,
      status: resp.status,
      metaResponse: resp.data
    };
  } catch (err: unknown) {
    const normalized = normalizeAxiosError(err);

    logJson("warn", "meta.reply.fb.send_failed", {
      requestId,
      channelId,
      pageId,
      userId,
      attempt: 1,
      status: normalized.status,
      error: normalized.data
    });

    // Attempt refresh if token error
    if (!isMetaTokenErrorNeedingRefresh(err)) {
      return {
        ok: false,
        attempt: 1,
        refreshedToken: false,
        status: normalized.status,
        metaError: normalized.data,
        reason: "REQUEST_FAILED"
      };
    }

    logJson("info", "meta.reply.fb.refresh_token.start", { requestId, channelId });
    const refreshed = await refreshPageAccessTokenForChannel(channelId);

    if (!refreshed?.accessToken) {
      logJson("error", "meta.reply.fb.refresh_token.failed", { requestId, channelId });
      return {
        ok: false,
        attempt: 2,
        refreshedToken: true,
        status: normalized.status,
        metaError: normalized.data,
        reason: "TOKEN_REFRESH_FAILED"
      };
    }

    accessToken = refreshed.accessToken;

    // Attempt 2 (after refresh)
    try {
      const resp2 = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      });

      logJson("info", "meta.reply.fb.refresh_token.succeeded", { requestId, channelId });

      return {
        ok: true,
        attempt: 2,
        refreshedToken: true,
        status: resp2.status,
        metaResponse: resp2.data
      };
    } catch (err2: unknown) {
      const normalized2 = normalizeAxiosError(err2);
      logJson("error", "meta.reply.fb.send_failed_after_refresh", {
        requestId,
        channelId,
        pageId,
        userId,
        attempt: 2,
        status: normalized2.status,
        error: normalized2.data
      });

      return {
        ok: false,
        attempt: 2,
        refreshedToken: true,
        status: normalized2.status,
        metaError: normalized2.data,
        reason: "REQUEST_FAILED"
      };
    }
  }
}

async function sendInstagramReply(
  requestId: string,
  channelId: string,
  igBusinessId: string,
  userId: string,
  reply: string
): Promise<SendReplyResult> {
  const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
  if (!channel) {
    logJson("error", "meta.reply.ig.channel_not_found", { requestId, channelId });
    return {
      ok: false,
      attempt: 1,
      refreshedToken: false,
      reason: "CHANNEL_NOT_FOUND"
    };
  }

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken || !config.metaGraphApiBaseUrl) {
    logJson("error", "meta.reply.ig.config_missing", {
      requestId,
      channelId,
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

  const url = `${config.metaGraphApiBaseUrl}/${igBusinessId}/messages`;
  const body = {
    messaging_type: "RESPONSE",
    recipient: { id: userId },
    message: { text: reply }
  };

  // Attempt 1
  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    return {
      ok: true,
      attempt: 1,
      refreshedToken: false,
      status: resp.status,
      metaResponse: resp.data
    };
  } catch (err: unknown) {
    const normalized = normalizeAxiosError(err);

    logJson("warn", "meta.reply.ig.send_failed", {
      requestId,
      channelId,
      igBusinessId,
      userId,
      attempt: 1,
      status: normalized.status,
      error: normalized.data
    });

    if (!isMetaTokenErrorNeedingRefresh(err)) {
      return {
        ok: false,
        attempt: 1,
        refreshedToken: false,
        status: normalized.status,
        metaError: normalized.data,
        reason: "REQUEST_FAILED"
      };
    }

    logJson("info", "meta.reply.ig.refresh_token.start", { requestId, channelId });
    const refreshed = await refreshPageAccessTokenForChannel(channelId);

    if (!refreshed?.accessToken) {
      logJson("error", "meta.reply.ig.refresh_token.failed", { requestId, channelId });
      return {
        ok: false,
        attempt: 2,
        refreshedToken: true,
        status: normalized.status,
        metaError: normalized.data,
        reason: "TOKEN_REFRESH_FAILED"
      };
    }

    accessToken = refreshed.accessToken;

    // Attempt 2 (after refresh)
    try {
      const resp2 = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      });

      logJson("info", "meta.reply.ig.refresh_token.succeeded", { requestId, channelId });

      return {
        ok: true,
        attempt: 2,
        refreshedToken: true,
        status: resp2.status,
        metaResponse: resp2.data
      };
    } catch (err2: unknown) {
      const normalized2 = normalizeAxiosError(err2);
      logJson("error", "meta.reply.ig.send_failed_after_refresh", {
        requestId,
        channelId,
        igBusinessId,
        userId,
        attempt: 2,
        status: normalized2.status,
        error: normalized2.data
      });

      return {
        ok: false,
        attempt: 2,
        refreshedToken: true,
        status: normalized2.status,
        metaError: normalized2.data,
        reason: "REQUEST_FAILED"
      };
    }
  }
}

// POST /webhook/meta
router.post("/", async (req: Request, res: Response) => {
  const requestId = getRequestId(req);
  const receivedAt = Date.now();

  const body: unknown = req.body;

  // Log receipt (this is the big one you’ll want for review)
  const objectType =
    typeof (body as any)?.object === "string" ? (body as any).object : "unknown";

  const entryCount = Array.isArray((body as any)?.entry) ? (body as any).entry.length : 0;

  logJson("info", "meta.webhook.received", {
    requestId,
    object: objectType,
    entryCount,
    hasSignature:
      Boolean(req.headers["x-hub-signature"]) || Boolean(req.headers["x-hub-signature-256"]),
    userAgent: req.headers["user-agent"],
    durationMs: Date.now() - receivedAt
  });

  // Always ack Meta quickly; processing continues but we still respond at the end.
  if (!body || typeof body !== "object" || !(body as any).object) {
    logJson("warn", "meta.webhook.ignored", {
      requestId,
      reason: "missing_body_or_object"
    });
    return res.sendStatus(200);
  }

  try {
    if ((body as any).object === "page") {
      // Facebook Messenger
      const entries = Array.isArray((body as any).entry) ? (body as any).entry : [];

      for (const entry of entries) {
        const pageId: string | undefined = entry?.id;
        const messagingEvents = Array.isArray(entry?.messaging) ? entry.messaging : [];

        logJson("debug", "meta.webhook.page.entry", {
          requestId,
          pageId,
          messagingEventCount: messagingEvents.length
        });

        for (const event of messagingEvents) {
          const message = event?.message;
          const sender = event?.sender;

          // Ignore non-text messages, echoes, delivery/read events etc.
          const text: string | undefined = message?.text;
          const userId: string | undefined = sender?.id;
          const mid: string | undefined = message?.mid;

          if (!pageId || !userId) continue;
          if (!message || !text) {
            logJson("debug", "meta.webhook.page.event_ignored", {
              requestId,
              pageId,
              userId,
              mid,
              reason: "no_text_message"
            });
            continue;
          }

          logJson("info", "meta.message.received", {
            requestId,
            platform: "FACEBOOK",
            pageId,
            userId,
            mid,
            textSnippet: safeSnippet(text),
            textLength: text.length
          });

          const channel = await prisma.botChannel.findFirst({
            where: { type: "FACEBOOK", externalId: pageId },
            include: { bot: true }
          });

          if (!channel?.bot) {
            logJson("warn", "meta.message.unlinked", {
              requestId,
              platform: "FACEBOOK",
              pageId,
              userId,
              mid
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            logJson("warn", "meta.message.bot_inactive", {
              requestId,
              platform: "FACEBOOK",
              botId: bot.id,
              botSlug: bot.slug,
              status: bot.status,
              pageId,
              userId,
              mid
            });
            continue;
          }

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "FACEBOOK",
            externalUserId: userId
          });

          logJson("info", "meta.conversation.resolved", {
            requestId,
            platform: "FACEBOOK",
            channelId: channel.id,
            botId: bot.id,
            botSlug: bot.slug,
            conversationId: convo.id,
            pageId,
            userId,
            mid
          });

          // --- Rate limiting ---
          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            logJson("warn", "meta.rate_limited", {
              requestId,
              platform: "FACEBOOK",
              conversationId: convo.id,
              retryAfterSeconds: rateResult.retryAfterSeconds
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
            } catch (logErr: unknown) {
              logJson("error", "meta.db.log_failed", {
                requestId,
                platform: "FACEBOOK",
                conversationId: convo.id,
                error: logErr
              });
            }

            const sendResult = await sendFacebookReply(
              requestId,
              channel.id,
              pageId,
              userId,
              rateMessage
            );

            logJson(sendResult.ok ? "info" : "error", "meta.reply.sent", {
              requestId,
              platform: "FACEBOOK",
              conversationId: convo.id,
              channelId: channel.id,
              pageId,
              userId,
              mid,
              replyType: "RATE_LIMIT",
              replyLength: rateMessage.length,
              sendResult
            });

            continue;
          }

          // --- Normal path: call chat service with conversationId for memory ---
          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, {
            conversationId: convo.id
          });
          const chatMs = Date.now() - t0;

          logJson("info", "meta.reply.generated", {
            requestId,
            platform: "FACEBOOK",
            conversationId: convo.id,
            botSlug: bot.slug,
            chatLatencyMs: chatMs,
            replySnippet: safeSnippet(reply),
            replyLength: reply.length
          });

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

          const sendResult = await sendFacebookReply(
            requestId,
            channel.id,
            pageId,
            userId,
            reply
          );

          logJson(sendResult.ok ? "info" : "error", "meta.reply.sent", {
            requestId,
            platform: "FACEBOOK",
            conversationId: convo.id,
            channelId: channel.id,
            pageId,
            userId,
            mid,
            replyType: "NORMAL",
            replyLength: reply.length,
            sendResult
          });
        }
      }
    } else if ((body as any).object === "instagram") {
      // Instagram DM
      const entries = Array.isArray((body as any).entry) ? (body as any).entry : [];

      for (const entry of entries) {
        const igBusinessId: string | undefined = entry?.id;
        const messagingEvents = Array.isArray(entry?.messaging) ? entry.messaging : [];

        logJson("debug", "meta.webhook.instagram.entry", {
          requestId,
          igBusinessId,
          messagingEventCount: messagingEvents.length
        });

        for (const event of messagingEvents) {
          const message = event?.message;
          const sender = event?.sender;

          const text: string | undefined = message?.text;
          const userId: string | undefined = sender?.id;
          const mid: string | undefined = message?.mid;

          if (!igBusinessId || !userId) continue;
          if (!message || !text) {
            logJson("debug", "meta.webhook.instagram.event_ignored", {
              requestId,
              igBusinessId,
              userId,
              mid,
              reason: "no_text_message"
            });
            continue;
          }

          logJson("info", "meta.message.received", {
            requestId,
            platform: "INSTAGRAM",
            igBusinessId,
            userId,
            mid,
            textSnippet: safeSnippet(text),
            textLength: text.length
          });

          const channel = await prisma.botChannel.findFirst({
            where: { type: "INSTAGRAM", externalId: igBusinessId },
            include: { bot: true }
          });

          if (!channel?.bot) {
            logJson("warn", "meta.message.unlinked", {
              requestId,
              platform: "INSTAGRAM",
              igBusinessId,
              userId,
              mid
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            logJson("warn", "meta.message.bot_inactive", {
              requestId,
              platform: "INSTAGRAM",
              botId: bot.id,
              botSlug: bot.slug,
              status: bot.status,
              igBusinessId,
              userId,
              mid
            });
            continue;
          }

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "INSTAGRAM",
            externalUserId: userId
          });

          logJson("info", "meta.conversation.resolved", {
            requestId,
            platform: "INSTAGRAM",
            channelId: channel.id,
            botId: bot.id,
            botSlug: bot.slug,
            conversationId: convo.id,
            igBusinessId,
            userId,
            mid
          });

          // --- Rate limiting ---
          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            logJson("warn", "meta.rate_limited", {
              requestId,
              platform: "INSTAGRAM",
              conversationId: convo.id,
              retryAfterSeconds: rateResult.retryAfterSeconds
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
            } catch (logErr: unknown) {
              logJson("error", "meta.db.log_failed", {
                requestId,
                platform: "INSTAGRAM",
                conversationId: convo.id,
                error: logErr
              });
            }

            const sendResult = await sendInstagramReply(
              requestId,
              channel.id,
              igBusinessId,
              userId,
              rateMessage
            );

            logJson(sendResult.ok ? "info" : "error", "meta.reply.sent", {
              requestId,
              platform: "INSTAGRAM",
              conversationId: convo.id,
              channelId: channel.id,
              igBusinessId,
              userId,
              mid,
              replyType: "RATE_LIMIT",
              replyLength: rateMessage.length,
              sendResult
            });

            continue;
          }

          // --- Normal path: call chat service with conversationId for memory ---
          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, {
            conversationId: convo.id
          });
          const chatMs = Date.now() - t0;

          logJson("info", "meta.reply.generated", {
            requestId,
            platform: "INSTAGRAM",
            conversationId: convo.id,
            botSlug: bot.slug,
            chatLatencyMs: chatMs,
            replySnippet: safeSnippet(reply),
            replyLength: reply.length
          });

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

          const sendResult = await sendInstagramReply(
            requestId,
            channel.id,
            igBusinessId,
            userId,
            reply
          );

          logJson(sendResult.ok ? "info" : "error", "meta.reply.sent", {
            requestId,
            platform: "INSTAGRAM",
            conversationId: convo.id,
            channelId: channel.id,
            igBusinessId,
            userId,
            mid,
            replyType: "NORMAL",
            replyLength: reply.length,
            sendResult
          });
        }
      }
    } else {
      logJson("info", "meta.webhook.ignored", {
        requestId,
        reason: "unsupported_object",
        object: (body as any).object
      });
    }
  } catch (err: unknown) {
    logJson("error", "meta.webhook.error", {
      requestId,
      error: err
    });
  }

  logJson("debug", "meta.webhook.done", {
    requestId,
    durationMs: Date.now() - receivedAt
  });

  return res.sendStatus(200);
});

export default router;
