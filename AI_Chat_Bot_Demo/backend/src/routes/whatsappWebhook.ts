// routes/whatsappWebhook.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import util from "node:util";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { findOrCreateConversation, logMessage, HUMAN_HANDOFF_MESSAGE, shouldSwitchToHumanMode } from "../services/conversationService";
import { generateBotReplyForSlug } from "../services/chatService";
import { checkConversationRateLimit, buildRateLimitMessage } from "../services/rateLimitService";

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
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (typeof v === "string") {
    const needsQuotes = /[\s"=|]/.test(v);
    return needsQuotes ? JSON.stringify(v) : v;
  }

  return util.inspect(v, { depth: 2, breakLength: 160, compact: true });
}

function fmtCtx(ctx: Record<string, unknown>) {
  const entries = Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, v] as const);

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${formatVal(v)}`).join(" ");
}

function logLine(level: Level, src: "WA" | "META", msg: string, ctx: Record<string, unknown> = {}) {
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

export function normalizeAxiosError(err: unknown) {
  if (!axios.isAxiosError(err)) return { status: undefined, data: err };
  return { status: err.response?.status, data: err.response?.data ?? err.message };
}

export function isWhatsAppAuthError(err: unknown): boolean {
  const ax = axios.isAxiosError(err) ? err : undefined;
  const status = ax?.response?.status;
  const code = (ax?.response?.data as any)?.error?.code;
  return status === 401 || status === 403 || code === 190;
}

function extractWaMessageId(data: unknown): string | undefined {
  const d: any = data;
  return d?.messages?.[0]?.id || d?.message_id || d?.id;
}

export async function markWhatsAppNeedsReconnect(requestId: string, channelId: string, context: string) {
  try {
    const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
    const currentMeta = (channel?.meta as any) || {};

    await prisma.botChannel.update({
      where: { id: channelId },
      data: {
        meta: { ...currentMeta, needsReconnect: true }
      }
    });

    logLine("WARN", "WA", "marked needsReconnect", { req: requestId, channel: channelId, ctx: context });
  } catch (e: unknown) {
    logLine("ERROR", "WA", "mark needsReconnect failed", { req: requestId, channel: channelId });
    logLine("DEBUG", "WA", "mark needsReconnect failed details", { req: requestId, details: e });
  }
}

// GET /webhook/whatsapp (verification)
router.get("/", (req: Request, res: Response) => {
  const requestId = getRequestId(req);

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token === config.whatsappVerifyToken;

  logLine(ok ? "INFO" : "WARN", "WA", "verify", { req: requestId, mode, verified: ok });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// POST /webhook/whatsapp (events)
router.post("/", async (req: Request, res: Response) => {
  const requestId = getRequestId(req);
  const startedAt = Date.now();

  const body: unknown = req.body;
  const entryCount = Array.isArray((body as any)?.entry) ? (body as any).entry.length : 0;

  logLine("INFO", "WA", "⇢ webhook received", { req: requestId, entries: entryCount });

  if (!body || typeof body !== "object" || !(body as any).entry) {
    logLine("DEBUG", "WA", "ignored", { req: requestId, reason: "missing body/entry" });
    return res.sendStatus(200);
  }

  try {
    const entries = Array.isArray((body as any).entry) ? (body as any).entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value;
        const metadata = value?.metadata;
        const phoneNumberId: string | undefined = metadata?.phone_number_id;

        const messages = Array.isArray(value?.messages) ? value.messages : [];
        if (!phoneNumberId || messages.length === 0) continue;

        for (const msg of messages) {
          if (msg?.type !== "text" || !msg?.text?.body) {
            logLine("DEBUG", "WA", "ignored (non-text)", {
              req: requestId,
              phone: shortId(phoneNumberId),
              id: shortId(msg?.id),
              type: msg?.type
            });
            continue;
          }

          const userWaId: string | undefined = msg.from;
          const text: string = msg.text.body;
          const messageId: string | undefined = msg.id;

          if (!userWaId) continue;

          logLine("INFO", "WA", "message received", {
            req: requestId,
            phone: shortId(phoneNumberId),
            user: shortId(userWaId),
            id: shortId(messageId),
            text: safeSnippet(text)
          });

          const channel = await prisma.botChannel.findFirst({
            where: { type: "WHATSAPP", externalId: phoneNumberId },
            include: { bot: true }
          });

          if (!channel?.bot) {
            logLine("WARN", "WA", "unlinked phone_number_id", {
              req: requestId,
              phone: shortId(phoneNumberId),
              user: shortId(userWaId),
              id: shortId(messageId)
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            logLine("WARN", "WA", "bot inactive", { req: requestId, bot: bot.slug, status: bot.status });
            continue;
          }

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "WHATSAPP",
            externalUserId: userWaId
          });

          logLine("INFO", "WA", "conversation resolved", {
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
      channelMessageId: messageId
    });
    const assistantMsg = await logMessage({
      conversationId: convo.id,
      role: "ASSISTANT",
      content: HUMAN_HANDOFF_MESSAGE
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
  } catch (e: unknown) {
    logLine("ERROR", "WA", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "WA", "db log failed details", {
      req: requestId,
      details: e
    });
  }

  if (!config.whatsappApiBaseUrl) {
    logLine("ERROR", "WA", "missing whatsappApiBaseUrl", { req: requestId });
    // still notify agents that a HUMAN handoff happened
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
      logLine("ERROR", "WA", "socket emit failed (WA handoff, no API)", {
        req: requestId,
        convo: convo.id
      });
      logLine("DEBUG", "WA", "socket emit failed details", {
        req: requestId,
        details: err
      });
    }
    continue;
  }

  const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
  const accessToken = channel.accessToken || config.whatsappAccessToken;

  if (!accessToken) {
    logLine("ERROR", "WA", "missing access token", {
      req: requestId,
      channel: channel.id
    });

    // still emit to the app
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
      logLine("ERROR", "WA", "socket emit failed (WA handoff, no token)", {
        req: requestId,
        convo: convo.id
      });
      logLine("DEBUG", "WA", "socket emit failed details", {
        req: requestId,
        details: err
      });
    }

    continue;
  }

  try {
    const resp = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: userWaId,
        text: { body: HUMAN_HANDOFF_MESSAGE }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    logLine("INFO", "WA", "reply sent", {
      req: requestId,
      type: "HUMAN_HANDOFF",
      status: resp.status,
      waMsgId: shortId(extractWaMessageId(resp.data))
    });
  } catch (err: unknown) {
    const n = normalizeAxiosError(err);

    logLine("ERROR", "WA", "reply send failed", {
      req: requestId,
      type: "HUMAN_HANDOFF",
      status: n.status
    });
    logLine("DEBUG", "WA", "reply send failed details", {
      req: requestId,
      details: n.data
    });

    if (isWhatsAppAuthError(err)) {
      await markWhatsAppNeedsReconnect(
        requestId,
        channel.id,
        "handoff_send_auth_error"
      );
    }
  }

  // 🔴 NEW: Socket.IO emit (normal path)
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
    logLine("ERROR", "WA", "socket emit failed (WA handoff)", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "WA", "socket emit failed details", {
      req: requestId,
      details: err
    });
  }

            try {
              await sendHumanConversationPush(bot.userId, {
                conversationId: convo.id,
                botId: bot.id,
                botName: bot.name,
                channel: "WHATSAPP"
                });
            } catch (pushErr) {
              logLine("ERROR", "WA", "push send failed", {
                req: requestId,
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
      channelMessageId: messageId
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg);
  } catch (e: unknown) {
    logLine("ERROR", "WA", "db log failed", {
      req: requestId,
      convo: convo.id
    });
    logLine("DEBUG", "WA", "db log failed details", {
      req: requestId,
      details: e
    });
  }

  logLine("INFO", "WA", "human handoff active, skipping bot reply", {
    req: requestId,
    convo: convo.id
  });

  continue;
}
          

          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            logLine("WARN", "WA", "rate limited", {
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
      channelMessageId: messageId
    });
    const assistantMsg = await logMessage({
      conversationId: convo.id,
      role: "ASSISTANT",
      content: rateMessage
    });

    emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
  } catch (e: unknown) {
    logLine("ERROR", "WA", "db log failed", { req: requestId, convo: convo.id });
    logLine("DEBUG", "WA", "db log failed details", { req: requestId, details: e });
  }

            if (!config.whatsappApiBaseUrl) {
              logLine("ERROR", "WA", "missing whatsappApiBaseUrl", { req: requestId });
              continue;
            }

            const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
            const accessToken = channel.accessToken || config.whatsappAccessToken;

            if (!accessToken) {
              logLine("ERROR", "WA", "missing access token", { req: requestId, channel: channel.id });
              continue;
            }

            try {
              const resp = await axios.post(
                url,
                { messaging_product: "whatsapp", to: userWaId, text: { body: rateMessage } },
                { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, timeout: 10000 }
              );

              logLine("INFO", "WA", "reply sent", {
                req: requestId,
                type: "RATE_LIMIT",
                status: resp.status,
                waMsgId: shortId(extractWaMessageId(resp.data))
              });
            } catch (err: unknown) {
              const n = normalizeAxiosError(err);

              logLine("ERROR", "WA", "reply send failed", {
                req: requestId,
                type: "RATE_LIMIT",
                status: n.status
              });
              logLine("DEBUG", "WA", "reply send failed details", { req: requestId, details: n.data });

              if (isWhatsAppAuthError(err)) {
                await markWhatsAppNeedsReconnect(requestId, channel.id, "rate_limit_send_auth_error");
              }
            }

            continue;
          }

          const t0 = Date.now();
          const reply = await generateBotReplyForSlug(bot.slug, text, { conversationId: convo.id });
          const chatMs = Date.now() - t0;

          logLine("INFO", "WA", "reply generated", {
            req: requestId,
            convo: convo.id,
            ms: chatMs,
            reply: safeSnippet(reply)
          });

          const io = req.app.get("io") as SocketIOServer | undefined;

try {
  const userMsg = await logMessage({
    conversationId: convo.id,
    role: "USER",
    content: text,
    channelMessageId: messageId
  });
  const assistantMsg = await logMessage({
    conversationId: convo.id,
    role: "ASSISTANT",
    content: reply
  });

  emitConversationMessages(io, bot.userId, convo.id, bot.id, userMsg, assistantMsg);
} catch (e: unknown) {
  logLine("ERROR", "WA", "db log failed", { req: requestId, convo: convo.id });
  logLine("DEBUG", "WA", "db log failed details", { req: requestId, details: e });
}

          if (!config.whatsappApiBaseUrl) {
            logLine("ERROR", "WA", "missing whatsappApiBaseUrl", { req: requestId });
            continue;
          }

          const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
          const accessToken = channel.accessToken || config.whatsappAccessToken;

          if (!accessToken) {
            logLine("ERROR", "WA", "missing access token", { req: requestId, channel: channel.id });
            continue;
          }

          try {
            const resp = await axios.post(
              url,
              { messaging_product: "whatsapp", to: userWaId, text: { body: reply } },
              { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, timeout: 10000 }
            );

            logLine("INFO", "WA", "reply sent", {
              req: requestId,
              type: "NORMAL",
              status: resp.status,
              waMsgId: shortId(extractWaMessageId(resp.data))
            });
          } catch (err: unknown) {
            const n = normalizeAxiosError(err);

            logLine("ERROR", "WA", "reply send failed", {
              req: requestId,
              type: "NORMAL",
              status: n.status
            });
            logLine("DEBUG", "WA", "reply send failed details", { req: requestId, details: n.data });

            if (isWhatsAppAuthError(err)) {
              await markWhatsAppNeedsReconnect(requestId, channel.id, "send_auth_error");
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    logLine("ERROR", "WA", "webhook error", { req: requestId });
    logLine("DEBUG", "WA", "webhook error details", { req: requestId, details: err });
  }

  logLine("INFO", "WA", "⇠ done", { req: requestId, ms: Date.now() - startedAt });
  return res.sendStatus(200);
});

export default router;
