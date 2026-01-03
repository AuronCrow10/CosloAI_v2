// routes/chat.ts

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  generateBotReplyForSlug,
  ChatServiceError
} from "../services/chatService";
import { getBotConfigBySlug } from "../bots/config";

import { prisma } from "../prisma/prisma";
import {
  findOrCreateConversation,
  logMessage,
  HUMAN_HANDOFF_MESSAGE,
  shouldSwitchToHumanMode
} from "../services/conversationService";
import { evaluateConversation } from "../services/conversationAnalyticsService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "../services/rateLimitService";

import { ConversationMode } from "@prisma/client";


import type { Server as SocketIOServer } from "socket.io";
import { sendHumanConversationPush } from "../services/pushNotificationService";

const router = Router();

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

// POST /api/chat/:slug
// POST /api/chat/:slug
router.post("/chat/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;

  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "Invalid bot slug format" });
  }

  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    return res.status(404).json({ error: "Bot not found" });
  }

  const { message, conversationId } = req.body || {};

  if (typeof message !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'message' field" });
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  const convId =
    typeof conversationId === "string" && conversationId ? conversationId : uuidv4();

  const externalUserId =
    (req.headers["x-session-id"] as string) || `web:${convId}`;

  let dbConversationId: string | null = null;

  try {
    const dbBot = await prisma.bot.findUnique({ where: { slug } });

    if (dbBot) {
      const convo = await findOrCreateConversation({
        botId: dbBot.id,
        channel: "WEB",
        externalUserId
      });

      dbConversationId = convo.id;

      // --- HUMAN fallback detection (before rate limit / AI) ---
      const wantsHuman = shouldSwitchToHumanMode(trimmedMessage);

      if (wantsHuman && convo.mode !== "HUMAN") {
        const updated = await prisma.conversation.update({
          where: { id: convo.id },
          data: { mode: ConversationMode.HUMAN }
        });

        // Log user request + generic handoff message
        try {
          await logMessage({
            conversationId: convo.id,
            role: "USER",
            content: trimmedMessage
          });

          await logMessage({
            conversationId: convo.id,
            role: "ASSISTANT",
            content: HUMAN_HANDOFF_MESSAGE
          });
        } catch (logErr) {
          console.error("Failed to log HUMAN handoff for web chat", logErr);
        }

        // NEW: notify the agent via Socket.IO
        try {
          const io = req.app.get("io") as SocketIOServer | undefined;

          if (io && dbBot) {
            const now = new Date();
            io.to(`user:${dbBot.userId}`).emit("conversation:modeChanged", {
              conversationId: convo.id,
              botId: convo.botId,
              mode: updated.mode,
              channel: convo.channel,
              lastMessageAt: now,
              lastUserMessageAt: now
            });
          }
        } catch (err) {
          console.error(
            "Failed to emit conversation:modeChanged for web chat handoff",
            err
          );
        }

        if (dbBot) {
          try {
            await sendHumanConversationPush(dbBot.userId, {
              conversationId: convo.id,
              botId: dbBot.id,
              botName: dbBot.name,
              channel: "WEB"
            });
          } catch (pushErr) {
            console.error(
              "Failed to send HUMAN conversation push notification (WEB)",
              pushErr
            );
          }
        }

        // Keep response shape backwards-compatible
        return res.json({
          conversationId: convId,
          reply: HUMAN_HANDOFF_MESSAGE,
          humanMode: true
        });
      }

      if (convo.mode === "HUMAN") {
        // Already in HUMAN mode: log the user message only, do NOT call the AI
        try {
          await logMessage({
            conversationId: convo.id,
            role: "USER",
            content: trimmedMessage
          });
        } catch (logErr) {
          console.error(
            "Failed to log user message while in HUMAN mode (web chat)",
            logErr
          );
        }

        // Keep response shape backwards-compatible
        return res.json({
          conversationId: convId,
          reply: HUMAN_HANDOFF_MESSAGE,
          humanMode: true
        });
      }

      // --- Rate limiting for this conversation (DB bots only, AI mode only) ---
      const rateResult = await checkConversationRateLimit(convo.id);
      if (rateResult.isLimited) {
        const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

        try {
          await logMessage({
            conversationId: convo.id,
            role: "USER",
            content: trimmedMessage
          });

          await logMessage({
            conversationId: convo.id,
            role: "ASSISTANT",
            content: rateMessage
          });
        } catch (logErr) {
          console.error(
            "Failed to log rate-limited web conversation/messages",
            logErr
          );
        }

        return res.json({
          conversationId: convId,
          reply: rateMessage
        });
      }
    }

    // --- Call chat service (only when in AI mode) ---
    const reply = await generateBotReplyForSlug(slug, trimmedMessage, {
      conversationId: dbConversationId ?? undefined
    });

    try {
  if (dbConversationId && dbBot) {
    const userMsg = await logMessage({
      conversationId: dbConversationId,
      role: "USER",
      content: trimmedMessage
    });

    const assistantMsg = await logMessage({
      conversationId: dbConversationId,
      role: "ASSISTANT",
      content: reply
    });

    const io = req.app.get("io") as SocketIOServer | undefined;
    if (io) {
      io.to(`user:${dbBot.userId}`).emit("conversation:messageCreated", {
        conversationId: dbConversationId,
        botId: dbBot.id,
        message: userMsg
      });

      io.to(`user:${dbBot.userId}`).emit("conversation:messageCreated", {
        conversationId: dbConversationId,
        botId: dbBot.id,
        message: assistantMsg
      });
    }
  }
} catch (logErr) {
  console.error("Failed to log conversation/messages", logErr);
}

    // Optional evaluation unchanged...
    try {
      if (dbConversationId && dbBot && dbBot.autoEvaluateConversations) {
        const messageCount = await prisma.message.count({
          where: { conversationId: dbConversationId }
        });

        if (messageCount >= 6) {
          const existingAutoEval = await prisma.conversationEval.findFirst({
            where: {
              conversationId: dbConversationId,
              isAuto: true
            }
          });

          if (!existingAutoEval) {
            await evaluateConversation(slug, dbConversationId, true);
          }
        }
      }
    } catch (evalErr) {
      console.error("Failed to auto-evaluate conversation", evalErr);
    }

    return res.json({
      conversationId: convId,
      reply
    });
  } catch (err: any) {
    if (err instanceof ChatServiceError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Error in /api/chat:", err);
    return res.status(500).json({
      error: "Sorry, there was an error. Please try again."
    });
  }
});


export default router;
