// routes/whatsappWebhook.ts

import { Router, Request, Response } from "express";
import axios from "axios";
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

function isWhatsAppAuthError(err: any): boolean {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  // 401/403 HTTP or classic OAuth code 190
  return status === 401 || status === 403 || code === 190;
}

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

          // Create/find conversation BEFORE OpenAI so we can rate-limit and use memory
          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "WHATSAPP",
            externalUserId: userWaId
          });

          // --- Rate limiting ---
          const rateResult = await checkConversationRateLimit(convo.id);
          if (rateResult.isLimited) {
            const rateMessage = buildRateLimitMessage(rateResult.retryAfterSeconds);

            // Log user + rate-limit assistant messages (best effort)
            try {
              await logMessage({
                conversationId: convo.id,
                role: "USER",
                content: text,
                channelMessageId: msg.id
              });

              await logMessage({
                conversationId: convo.id,
                role: "ASSISTANT",
                content: rateMessage
              });
            } catch (logErr) {
              console.error(
                "Failed to log rate-limited WhatsApp conversation/messages",
                logErr
              );
            }

            if (!config.whatsappApiBaseUrl) {
              console.error("WhatsApp API base URL not configured");
              continue;
            }

            const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;

            // Prefer per-channel token (embedded signup) and fall back to global env token
            let accessToken = channel.accessToken || config.whatsappAccessToken;

            if (!accessToken) {
              console.error(
                "No WhatsApp access token configured for this channel",
                {
                  channelId: channel.id
                }
              );
              continue;
            }

            try {
              await axios.post(
                url,
                {
                  messaging_product: "whatsapp",
                  to: userWaId,
                  text: { body: rateMessage }
                },
                {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                  },
                  timeout: 10000
                }
              );
            } catch (err: any) {
              console.error(
                "Failed to send WhatsApp rate-limit message",
                err?.response?.data || err
              );

              if (isWhatsAppAuthError(err)) {
                try {
                  const currentMeta = (channel.meta as any) || {};
                  await prisma.botChannel.update({
                    where: { id: channel.id },
                    data: {
                      meta: {
                        ...currentMeta,
                        needsReconnect: true
                      }
                    }
                  });
                  console.warn(
                    "Marked WhatsApp channel as needsReconnect due to auth error (rate-limit send)",
                    {
                      channelId: channel.id
                    }
                  );
                } catch (updateErr) {
                  console.error(
                    "Failed to mark WhatsApp channel as needsReconnect (rate-limit send)",
                    updateErr
                  );
                }
              }
            }

            // Skip normal OpenAI reply when rate limited
            continue;
          }

          // --- Normal path: call chat service with conversationId for memory ---
          const reply = await generateBotReplyForSlug(bot.slug, text, {
            conversationId: convo.id
          });

          // Log conversation
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

          if (!config.whatsappApiBaseUrl) {
            console.error("WhatsApp API base URL not configured");
            continue;
          }

          const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;

          // Prefer per-channel token (embedded signup) and fall back to global env token
          let accessToken = channel.accessToken || config.whatsappAccessToken;

          if (!accessToken) {
            console.error("No WhatsApp access token configured for this channel", {
              channelId: channel.id
            });
            continue;
          }

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
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json"
                },
                timeout: 10000
              }
            );
          } catch (err: any) {
            console.error(
              "Failed to send WhatsApp message",
              err?.response?.data || err
            );

            if (isWhatsAppAuthError(err)) {
              try {
                const currentMeta = (channel.meta as any) || {};
                await prisma.botChannel.update({
                  where: { id: channel.id },
                  data: {
                    meta: {
                      ...currentMeta,
                      needsReconnect: true
                    }
                  }
                });
                console.warn(
                  "Marked WhatsApp channel as needsReconnect due to auth error",
                  {
                    channelId: channel.id
                  }
                );
              } catch (updateErr) {
                console.error(
                  "Failed to mark WhatsApp channel as needsReconnect",
                  updateErr
                );
              }
            }
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
