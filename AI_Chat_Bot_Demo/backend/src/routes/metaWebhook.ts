// src/routes/metaWebhook.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import {
  refreshPageAccessTokenForChannel,
  isMetaTokenErrorNeedingRefresh
} from "../services/metaTokenService";
import {
  findOrCreateConversation,
  logMessage
} from "../services/conversationService";
import { generateBotReplyForSlug } from "../services/chatService";

const router = Router();

// GET /webhook/meta (verification)
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.metaVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function sendFacebookReply(
  channelId: string,
  pageId: string,
  userId: string,
  reply: string
) {
  const channel = await prisma.botChannel.findUnique({
    where: { id: channelId }
  });

  if (!channel) {
    console.error("BotChannel not found while sending FB reply", { channelId });
    return;
  }

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken || !config.metaGraphApiBaseUrl) {
    console.error("Meta FB access token or base URL not configured");
    return;
  }

  const url = `${config.metaGraphApiBaseUrl}/${pageId}/messages`;

  const body = {
    messaging_type: "RESPONSE",
    recipient: { id: userId },
    message: { text: reply }
  };

  try {
    await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
  } catch (err: any) {
    console.error("Failed to send FB message (first attempt)", err?.response?.data || err);

    if (isMetaTokenErrorNeedingRefresh(err)) {
      console.log("Attempting to refresh FB page access token for channel", {
        channelId
      });
      const refreshed = await refreshPageAccessTokenForChannel(channelId);
      if (!refreshed || !refreshed.accessToken) {
        console.error("Could not refresh FB page token; channel may need reconnect", {
          channelId
        });
        return;
      }

      accessToken = refreshed.accessToken;
      try {
        await axios.post(url, body, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        });
        console.log("FB message sent successfully after token refresh", {
          channelId
        });
      } catch (err2) {
        console.error("Failed to send FB message after token refresh", err2);
      }
    }
  }
}

async function sendInstagramReply(
  channelId: string,
  igBusinessId: string,
  userId: string,
  reply: string
) {
  const channel = await prisma.botChannel.findUnique({
    where: { id: channelId }
  });

  if (!channel) {
    console.error("BotChannel not found while sending IG reply", { channelId });
    return;
  }

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken || !config.metaGraphApiBaseUrl) {
    console.error("Meta IG access token or base URL not configured");
    return;
  }

  const url = `${config.metaGraphApiBaseUrl}/${igBusinessId}/messages`;

  const body = {
    recipient: { id: userId },
    message: { text: reply }
  };

  try {
    await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
  } catch (err: any) {
    console.error("Failed to send IG message (first attempt)", err?.response?.data || err);

    if (isMetaTokenErrorNeedingRefresh(err)) {
      console.log("Attempting to refresh IG page access token for channel", {
        channelId
      });
      const refreshed = await refreshPageAccessTokenForChannel(channelId);
      if (!refreshed || !refreshed.accessToken) {
        console.error("Could not refresh IG page token; channel may need reconnect", {
          channelId
        });
        return;
      }

      accessToken = refreshed.accessToken;
      try {
        await axios.post(url, body, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        });
        console.log("IG message sent successfully after token refresh", {
          channelId
        });
      } catch (err2) {
        console.error("Failed to send IG message after token refresh", err2);
      }
    }
  }
}

// POST /webhook/meta
router.post("/", async (req: Request, res: Response) => {
  const body = req.body;
  if (!body || !body.object) {
    return res.sendStatus(200);
  }

  try {
    if (body.object === "page") {
      const entries = Array.isArray(body.entry) ? body.entry : [];
      for (const entry of entries) {
        const pageId: string = entry.id;
        const messagingEvents = Array.isArray(entry.messaging)
          ? entry.messaging
          : [];

        for (const event of messagingEvents) {
          const message = event.message;
          const sender = event.sender;
          if (!message || !message.text || !sender || !sender.id) continue;

          const userId: string = sender.id;
          const text: string = message.text;

          const channel = await prisma.botChannel.findFirst({
            where: {
              type: "FACEBOOK",
              externalId: pageId
            },
            include: { bot: true }
          });

          if (!channel || !channel.bot) {
            console.warn("FB page not linked to any bot", { pageId });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") continue;

          const reply = await generateBotReplyForSlug(bot.slug, text);

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "FACEBOOK",
            externalUserId: userId
          });

          await logMessage({
            conversationId: convo.id,
            role: "USER",
            content: text,
            channelMessageId: message.mid
          });

          await logMessage({
            conversationId: convo.id,
            role: "ASSISTANT",
            content: reply
          });

          await sendFacebookReply(channel.id, pageId, userId, reply);
        }
      }
    } else if (body.object === "instagram") {
      const entries = Array.isArray(body.entry) ? body.entry : [];
      for (const entry of entries) {
        const igBusinessId: string = entry.id;
        const messagingEvents = Array.isArray(entry.messaging)
          ? entry.messaging
          : [];

        for (const event of messagingEvents) {
          const message = event.message;
          const sender = event.sender;
          if (!message || !message.text || !sender || !sender.id) continue;

          const userId: string = sender.id;
          const text: string = message.text;

          const channel = await prisma.botChannel.findFirst({
            where: {
              type: "INSTAGRAM",
              externalId: igBusinessId
            },
            include: { bot: true }
          });

          if (!channel || !channel.bot) {
            console.warn("IG business account not linked to any bot", {
              igBusinessId
            });
            continue;
          }

          const bot = channel.bot;
          if (bot.status !== "ACTIVE") continue;

          const reply = await generateBotReplyForSlug(bot.slug, text);

          const convo = await findOrCreateConversation({
            botId: bot.id,
            channel: "INSTAGRAM",
            externalUserId: userId
          });

          await logMessage({
            conversationId: convo.id,
            role: "USER",
            content: text,
            channelMessageId: message.mid
          });

          await logMessage({
            conversationId: convo.id,
            role: "ASSISTANT",
            content: reply
          });

          await sendInstagramReply(channel.id, igBusinessId, userId, reply);
        }
      }
    } else {
      console.log("Ignoring unsupported Meta object:", body.object);
    }
  } catch (err) {
    console.error("Error processing Meta webhook", err);
  }

  return res.sendStatus(200);
});

export default router;
