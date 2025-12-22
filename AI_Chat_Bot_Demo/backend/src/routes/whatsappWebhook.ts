// routes/whatsappWebhook.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import {
  findOrCreateConversation,
  logMessage
} from "../services/conversationService";
import { generateBotReplyForSlug } from "../services/chatService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "../services/rateLimitService";

const router = Router();

/**
 * Structured, review-friendly JSON logs for WhatsApp webhook.
 * This is designed to clearly prove:
 * 1) webhook received
 * 2) inbound message parsed
 * 3) channel/bot/conversation resolved
 * 4) reply generated
 * 5) reply sent (or error + reconnect flagged)
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

function normalizeAxiosError(err: unknown) {
  if (!axios.isAxiosError(err)) return { status: undefined, data: err };
  return { status: err.response?.status, data: err.response?.data ?? err.message };
}

function isWhatsAppAuthError(err: unknown): boolean {
  const ax = axios.isAxiosError(err) ? err : undefined;
  const status = ax?.response?.status;
  const code = (ax?.response?.data as any)?.error?.code;
  // 401/403 HTTP or classic OAuth code 190
  return status === 401 || status === 403 || code === 190;
}

async function markWhatsAppNeedsReconnect(requestId: string, channelId: string, context: string) {
  try {
    const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
    const currentMeta = (channel?.meta as any) || {};

    await prisma.botChannel.update({
      where: { id: channelId },
      data: {
        meta: {
          ...currentMeta,
          needsReconnect: true
        }
      }
    });

    logJson("warn", "whatsapp.channel.needs_reconnect_marked", {
      requestId,
      channelId,
      context
    });
  } catch (updateErr: unknown) {
    logJson("error", "whatsapp.channel.needs_reconnect_failed", {
      requestId,
      channelId,
      context,
      error: updateErr
    });
  }
}

// GET /webhook/whatsapp (verification)
router.get("/", (req: Request, res: Response) => {
  const requestId = getRequestId(req);

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token === config.whatsappVerifyToken;

  logJson(ok ? "info" : "warn", "whatsapp.webhook.verify", {
    requestId,
    mode,
    tokenProvided: Boolean(token),
    challengeProvided: Boolean(challenge),
    verified: ok
  });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// POST /webhook/whatsapp (events)
router.post("/", async (req: Request, res: Response) => {
  const requestId = getRequestId(req);
  const startedAt = Date.now();

  const body: unknown = req.body;

  // Review-friendly receipt log
  const entryCount = Array.isArray((body as any)?.entry) ? (body as any).entry.length : 0;
  logJson("info", "whatsapp.webhook.received", {
    requestId,
    entryCount,
    hasSignature:
      Boolean(req.headers["x-hub-signature"]) || Boolean(req.headers["x-hub-signature-256"]),
    userAgent: req.headers["user-agent"]
  });

  if (!body || typeof body !== "object" || !(body as any).entry) {
    logJson("debug", "whatsapp.webhook.ignored", {
      requestId,
      reason: "missing_body_or_entry"
    });
    return res.sendStatus(200);
  }

  try {
    const entries = Array.isArray((body as any).entry) ? (body as any).entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];

      logJson("debug", "whatsapp.webhook.entry", {
        requestId,
        changeCount: changes.length
      });

      for (const change of changes) {
        const value = change?.value;

        const metadata = value?.metadata;
        const phoneNumberId: string | undefined = metadata?.phone_number_id;

        const messages = Array.isArray(value?.messages) ? value.messages : [];

        logJson("debug", "whatsapp.webhook.change", {
          requestId,
          phoneNumberId,
          messageCount: messages.length
        });

        if (!value || !metadata || messages.length === 0) continue;
        if (!phoneNumberId) {
          logJson("warn", "whatsapp.webhook.change_ignored", {
            requestId,
            reason: "missing_phone_number_id"
          });
          continue;
        }

        for (const msg of messages) {
          // Only handle inbound text messages
          if (msg?.type !== "text" || !msg?.text?.body) {
            logJson("debug", "whatsapp.message.ignored", {
              requestId,
              phoneNumberId,
              messageId: msg?.id,
              from: msg?.from,
              type: msg?.type,
              reason: "non_text_or_missing_body"
            });
            continue;
          }

          const userWaId: string | undefined = msg.from;
          const text: string = msg.text.body;
          const messageId: string | undefined = msg.id;

          if (!userWaId) {
            logJson("warn", "whatsapp.message.ignored", {
              requestId,
              phoneNumberId,
              messageId,
              reason: "missing_from"
            });
            continue;
          }

          logJson("info", "whatsapp.message.received", {
            requestId,
            phoneNumberId,
            userWaId,
            messageId,
            textSnippet: safeSnippet(text),
            textLength: text.length
          });

          // Map phone_number_id -> BotChannel -> Bot
          const channel = await prisma.botChannel.findFirst({
            where: { type: "WHATSAPP", externalId: phoneNumberId },
            include: { bot: true }
          });

          if (!channel?.bot) {
            logJson("warn", "whatsapp.channel.unlinked", {
              requestId,
              phoneNumberId,
              userWaId,
              messageId
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            logJson("warn", "whatsapp.bot.inactive", {
              requestId,
              botId: bot.id,
              botSlug: bot.slug,
              status: bot.status,
              channelId: channel.id,
              phoneNumberId,
              userWaId,
              messageId
            });
            continue;
          }

          // Create/find conversation BEFORE OpenAI so we can rate-limit and use memory
          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "WHATSAPP",
            externalUserId: userWaId
          });

          logJson("info", "whatsapp.conversation.resolved", {
            requestId,
            channelId: channel.id,
            botId: bot.id,
            botSlug: bot.slug,
            conversationId: convo.id,
            phoneNumberId,
            userWaId,
            messageId
          });

          // --- Rate limiting ---
          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            logJson("warn", "whatsapp.rate_limited", {
              requestId,
              conversationId: convo.id,
              retryAfterSeconds: rateResult.retryAfterSeconds
            });

            // Log user + rate-limit assistant messages (best effort)
            try {
              await logMessage({
                conversationId: convo.id,
                role: "USER",
                content: text,
                channelMessageId: messageId
              });

              await logMessage({
                conversationId: convo.id,
                role: "ASSISTANT",
                content: rateMessage
              });
            } catch (logErr: unknown) {
              logJson("error", "whatsapp.db.log_failed", {
                requestId,
                conversationId: convo.id,
                error: logErr
              });
            }

            if (!config.whatsappApiBaseUrl) {
              logJson("error", "whatsapp.config_missing", {
                requestId,
                reason: "missing_whatsappApiBaseUrl"
              });
              continue;
            }

            const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
            const accessToken = channel.accessToken || config.whatsappAccessToken;

            if (!accessToken) {
              logJson("error", "whatsapp.config_missing", {
                requestId,
                reason: "missing_access_token",
                channelId: channel.id
              });
              continue;
            }

            const sendBody = {
              messaging_product: "whatsapp",
              to: userWaId,
              text: { body: rateMessage }
            };

            try {
              const resp = await axios.post(url, sendBody, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json"
                },
                timeout: 10000
              });

              logJson("info", "whatsapp.reply.sent", {
                requestId,
                conversationId: convo.id,
                channelId: channel.id,
                phoneNumberId,
                userWaId,
                inReplyToMessageId: messageId,
                replyType: "RATE_LIMIT",
                replyLength: rateMessage.length,
                status: resp.status,
                metaResponse: resp.data
              });
            } catch (err: unknown) {
              const normalized = normalizeAxiosError(err);

              logJson("error", "whatsapp.reply.send_failed", {
                requestId,
                conversationId: convo.id,
                channelId: channel.id,
                phoneNumberId,
                userWaId,
                inReplyToMessageId: messageId,
                replyType: "RATE_LIMIT",
                status: normalized.status,
                error: normalized.data
              });

              if (isWhatsAppAuthError(err)) {
                await markWhatsAppNeedsReconnect(
                  requestId,
                  channel.id,
                  "rate_limit_send_auth_error"
                );
              }
            }

            continue; // Skip normal OpenAI reply when rate limited
          }

          // --- Normal path: call chat service with conversationId for memory ---
          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, {
            conversationId: convo.id
          });
          const chatMs = Date.now() - t0;

          logJson("info", "whatsapp.reply.generated", {
            requestId,
            conversationId: convo.id,
            botSlug: bot.slug,
            chatLatencyMs: chatMs,
            replySnippet: safeSnippet(reply),
            replyLength: reply.length
          });

          // Log conversation
          try {
            await logMessage({
              conversationId: convo.id,
              role: "USER",
              content: text,
              channelMessageId: messageId
            });

            await logMessage({
              conversationId: convo.id,
              role: "ASSISTANT",
              content: reply
            });
          } catch (logErr: unknown) {
            logJson("error", "whatsapp.db.log_failed", {
              requestId,
              conversationId: convo.id,
              error: logErr
            });
          }

          if (!config.whatsappApiBaseUrl) {
            logJson("error", "whatsapp.config_missing", {
              requestId,
              reason: "missing_whatsappApiBaseUrl"
            });
            continue;
          }

          const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
          const accessToken = channel.accessToken || config.whatsappAccessToken;

          if (!accessToken) {
            logJson("error", "whatsapp.config_missing", {
              requestId,
              reason: "missing_access_token",
              channelId: channel.id
            });
            continue;
          }

          const sendBody = {
            messaging_product: "whatsapp",
            to: userWaId,
            text: { body: reply }
          };

          try {
            const resp = await axios.post(url, sendBody, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
              },
              timeout: 10000
            });

            logJson("info", "whatsapp.reply.sent", {
              requestId,
              conversationId: convo.id,
              channelId: channel.id,
              phoneNumberId,
              userWaId,
              inReplyToMessageId: messageId,
              replyType: "NORMAL",
              replyLength: reply.length,
              status: resp.status,
              metaResponse: resp.data
            });
          } catch (err: unknown) {
            const normalized = normalizeAxiosError(err);

            logJson("error", "whatsapp.reply.send_failed", {
              requestId,
              conversationId: convo.id,
              channelId: channel.id,
              phoneNumberId,
              userWaId,
              inReplyToMessageId: messageId,
              replyType: "NORMAL",
              status: normalized.status,
              error: normalized.data
            });

            if (isWhatsAppAuthError(err)) {
              await markWhatsAppNeedsReconnect(requestId, channel.id, "send_auth_error");
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    logJson("error", "whatsapp.webhook.error", {
      requestId,
      error: err
    });
  }

  logJson("debug", "whatsapp.webhook.done", {
    requestId,
    durationMs: Date.now() - startedAt
  });

  return res.sendStatus(200);
});

export default router;
