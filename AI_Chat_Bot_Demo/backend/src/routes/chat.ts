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
  logMessage
} from "../services/conversationService";
import { evaluateConversation } from "../services/conversationAnalyticsService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "../services/rateLimitService";

const router = Router();

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

// POST /api/chat/:slug
router.post("/chat/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;

  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "Invalid bot slug format" });
  }

  // Ensure the bot exists in the DEMO_BOTS/DB registry (existing behavior)
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

  // externalUserId: prefer an explicit session id, fallback to a conv-based id
  const externalUserId =
    (req.headers["x-session-id"] as string) || `web:${convId}`;

  let dbConversationId: string | null = null;

  try {
    // Conversation creation BEFORE OpenAI, so we can load history & store logs
    const dbBot = await prisma.bot.findUnique({ where: { slug } });

    if (dbBot) {
      const convo = await findOrCreateConversation({
        botId: dbBot.id,
        channel: "WEB", // ChannelType.WEB in DB enum
        externalUserId
      });
      dbConversationId = convo.id;

      // --- Rate limiting for this conversation (DB bots only) ---
      const rateResult = await checkConversationRateLimit(dbConversationId);
      if (rateResult.isLimited) {
        const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

        // Best-effort logging; do not block on errors
        try {
          await logMessage({
            conversationId: dbConversationId,
            role: "USER",
            content: trimmedMessage
          });

          await logMessage({
            conversationId: dbConversationId,
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

    // --- Call chat service with optional DB conversationId for memory ---
    const reply = await generateBotReplyForSlug(slug, trimmedMessage, {
      conversationId: dbConversationId ?? undefined
    });

    // --- Conversation logging ---
    try {
      if (dbConversationId) {
        await logMessage({
          conversationId: dbConversationId,
          role: "USER",
          content: trimmedMessage
        });

        await logMessage({
          conversationId: dbConversationId,
          role: "ASSISTANT",
          content: reply
        });
      }
    } catch (logErr) {
      console.error("Failed to log conversation/messages", logErr);
      // Do not block the response if logging fails
    }

    // --- Optional automatic evaluation for this conversation ---
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
      // Never break chat flow because of eval issues
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
