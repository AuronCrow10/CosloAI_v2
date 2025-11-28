// routes/chat.ts

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { generateBotReplyForSlug, ChatServiceError } from "../services/chatService";
import { getBotConfigBySlug } from "../bots/config";

import { prisma } from "../prisma/prisma";
import {
  findOrCreateConversation,
  logMessage
} from "../services/conversationService";

const router = Router();

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

// POST /api/chat/:slug
router.post("/chat/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;
  console.log(slug);

  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "Invalid bot slug format" });
  }

  // Ensure the bot exists in the DEMO_BOTS registry (existing behavior)
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
    // --- NEW: conversation creation BEFORE OpenAI, so we can load history ---
    const dbBot = await prisma.bot.findUnique({ where: { slug } });

    if (dbBot) {
      const convo = await findOrCreateConversation({
        botId: dbBot.id,
        channel: "WEB", // ChannelType.WEB in DB enum
        externalUserId
      });
      dbConversationId = convo.id;
    }

    // --- Call chat service with optional DB conversationId for memory ---
    const reply = await generateBotReplyForSlug(slug, trimmedMessage, {
      conversationId: dbConversationId ?? undefined
    });

    // --- Conversation logging (same behavior, now reusing dbConversationId) ---
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
      } else {
        // Non fatal: slug exists only in DEMO_BOTS, no logging in DB
        // console.debug(`No DB bot found for slug=${slug}, skipping logging`);
      }
    } catch (logErr) {
      console.error("Failed to log conversation/messages", logErr);
      // Do not block the response if logging fails
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
