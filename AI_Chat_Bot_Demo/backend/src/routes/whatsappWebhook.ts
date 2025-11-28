import { Router, Request, Response } from "express";
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { findOrCreateConversation, logMessage } from "../services/conversationService";
import { generateBotReplyForSlug } from "../services/chatService";

const router = Router();

// GET /webhook/whatsapp (verification)
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsappVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /webhook/whatsapp (events)
router.post("/", async (req: Request, res: Response) => {
  const body = req.body;

  if (!body || !body.entry) {
    return res.sendStatus(200);
  }

  try {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value;
        if (!value || !value.messages || !value.metadata) continue;

        const messages = Array.isArray(value.messages) ? value.messages : [];
        const metadata = value.metadata;
        const phoneNumberId: string | undefined = metadata.phone_number_id;

        for (const msg of messages) {
          if (msg.type !== "text" || !msg.text || !msg.text.body) continue;

          const userWaId: string = msg.from;
          const text: string = msg.text.body;

          if (!phoneNumberId) continue;

          // Map phone_number_id -> BotChannel -> Bot
          const channel = await prisma.botChannel.findFirst({
            where: {
              type: "WHATSAPP",
              externalId: phoneNumberId
            },
            include: { bot: true }
          });

          if (!channel || !channel.bot) {
            console.warn("WhatsApp bot not configured for phone_number_id", {
              phoneNumberId
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") {
            console.warn("Ignoring message for non-active bot", { botId: bot.id });
            continue;
          }

          const reply = await generateBotReplyForSlug(bot.slug, text);

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "WHATSAPP",
            externalUserId: userWaId
          });

          await logMessage({
            conversationId: convo.id,
            role: "USER",
            content: text,
            channelMessageId: msg.id
          });

          await logMessage({
            conversationId: convo.id,
            role: "ASSISTANT",
            content: reply
          });

          // Send reply back via Cloud API
          if (!config.whatsappApiBaseUrl || !config.whatsappAccessToken) {
            console.error("WhatsApp API not configured");
            continue;
          }

          const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;

          try {
            await axios.post(
              url,
              {
                messaging_product: "whatsapp",
                to: userWaId,
                text: { body: reply }
              },
              {
                headers: {
                  Authorization: `Bearer ${config.whatsappAccessToken}`,
                  "Content-Type": "application/json"
                },
                timeout: 10000
              }
            );
          } catch (err) {
            console.error("Failed to send WhatsApp message", err);
          }
        }
      }
    }
  } catch (err) {
    console.error("Error processing WhatsApp webhook", err);
  }

  res.sendStatus(200);
});

export default router;
