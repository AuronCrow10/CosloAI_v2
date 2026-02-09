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
  shouldSwitchToHumanMode
} from "../services/conversationService";
import { evaluateConversation } from "../services/conversationAnalyticsService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "../services/rateLimitService";

import { ConversationMode } from "@prisma/client";


import type { Server as SocketIOServer } from "socket.io";

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

  let effectiveMessage = trimmedMessage;

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

      // --- HUMAN fallback detection (WEB) ---
      // Web channel should NOT switch to HUMAN mode. If the user asks for a human,
      // treat it like a contact-info request and keep AI mode.
      const wantsHuman = shouldSwitchToHumanMode(trimmedMessage);
      if (wantsHuman) {
        effectiveMessage =
          "The user asked to speak with a human. On the web channel, do NOT hand off. " +
          "Treat this as a contact-info request. Use any available website or Shopify context to provide contact details " +
          "(phone, email, address, hours, website, support options). " +
          "Do NOT invent business facts. If contact info is not clearly supported by CONTEXT, say you don't know and suggest checking the website or contacting the business. " +
          "Reply in the user's language when reasonable.\n\n" +
          "User message: " + trimmedMessage;
      }

      if (convo.mode === "HUMAN") {
        // Web channel does not honor HUMAN mode; continue in AI mode.
        try {
          await prisma.conversation.update({
            where: { id: convo.id },
            data: { mode: ConversationMode.AI }
          });
        } catch (err) {
          console.error("Failed to reset WEB conversation to AI mode", err);
        }
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
    const reply = await generateBotReplyForSlug(slug, effectiveMessage, {
      conversationId: dbConversationId ?? convId
    });
    console.log("[RAW REPLY]", reply);

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
