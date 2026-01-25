// services/metaMessageService.ts

import { config } from "../config";
import {
  getBotConfigBySlug,
  getBotSlugByFacebookPageId,
  getBotSlugByInstagramBusinessId
} from "../bots/config";
import { generateBotReplyForSlug } from "./chatService";
import {
  sendFacebookTextMessage,
  sendInstagramTextMessage
} from "../meta/client";
import {
  findOrCreateConversation,
  logMessage
} from "./conversationService";
import {
  checkConversationRateLimit,
  buildRateLimitMessage
} from "./rateLimitService";

/**
 * Ensure we have a DB Conversation for this (bot, channel, user) combo.
 * Returns the conversationId or null if this is a demo/static bot with no botId.
 */
async function ensureMetaConversation(options: {
  botId: string | null | undefined;
  channel: "FACEBOOK" | "INSTAGRAM";
  externalUserId: string;
}): Promise<string | null> {
  const { botId, channel, externalUserId } = options;
  if (!botId) return null; // static/demo bot → no DB conversation

  try {
    const convo = await findOrCreateConversation({
      botId,
      channel,
      externalUserId
    });
    return convo.id;
  } catch (err) {
    console.error("[Meta] Failed to find/create conversation", {
      botId,
      channel,
      externalUserId,
      error: err
    });
    return null;
  }
}

/**
 * Facebook Messenger handler (used by higher-level webhook/router).
 * - Uses DB conversation memory when botId is available
 * - Uses global rateLimitService so rate limits are identical to other channels
 */
export async function handleFacebookMessageEvent(params: {
  pageId: string;
  userId: string;
  text: string;
}): Promise<void> {
  const { pageId, userId, text } = params;
  const trimmedText = (text || "").trim();
  if (!trimmedText) {
    console.warn("[Meta][FB] Ignoring empty message", { pageId, userId });
    return;
  }

  const botSlug = await getBotSlugByFacebookPageId(pageId);
  if (!botSlug) {
    console.warn("[Meta][FB] No bot configured for pageId", { pageId });
    return;
  }

  const botConfig = await getBotConfigBySlug(botSlug);
  if (!botConfig) {
    console.warn("[Meta][FB] Bot config missing for slug", { botSlug });
    return;
  }

  // Determine access token: per-bot or global
  const pageAccessToken =
    botConfig.channels?.facebook?.pageAccessToken || config.metaPageAccessToken;

  if (!pageAccessToken) {
    console.error("[Meta][FB] No page access token configured", {
      pageId,
      botSlug
    });
    return;
  }

  // Create/attach conversation (DB bots only) BEFORE any reply decision
  const conversationId = await ensureMetaConversation({
    botId: botConfig.botId ?? null,
    channel: "FACEBOOK",
    externalUserId: userId
  });
  const draftConversationId =
    conversationId ?? `meta:${botSlug}:facebook:${userId}`;

  // --- Rate limiting (shared across all channels via rateLimitService) ---
  let isLimited = false;
  let rateLimitMessage: string | null = null;

  if (conversationId) {
    const rate = await checkConversationRateLimit(conversationId);
    if (rate.isLimited) {
      isLimited = true;
      rateLimitMessage = buildRateLimitMessage(rate.retryAfterSeconds);
    }
  }

  if (isLimited && rateLimitMessage) {
    // Log to conversation if available
    if (conversationId) {
      try {
        await logMessage({
          conversationId,
          role: "USER",
          content: trimmedText
        });
        await logMessage({
          conversationId,
          role: "ASSISTANT",
          content: rateLimitMessage
        });
      } catch (err) {
        console.error("[Meta][FB] Failed to log rate-limited messages", {
          conversationId,
          error: err
        });
      }
    }

    // Send static rate limit reply (no OpenAI cost)
    try {
      await sendFacebookTextMessage({
        pageId,
        accessToken: pageAccessToken,
        recipientId: userId,
        text: rateLimitMessage
      });

      console.log("[Meta][FB] Rate limit message sent", {
        pageId,
        botSlug,
        userId
      });
    } catch (err) {
      console.error("[Meta][FB] Error sending rate limit message", {
        pageId,
        botSlug,
        userId,
        error: err
      });
    }

    return;
  }

  // --- Not rate-limited → normal AI flow with memory ---
  try {
    console.log("[Meta][FB] Incoming message", {
      pageId,
      botSlug,
      userId,
      text: trimmedText
    });

    const reply = await generateBotReplyForSlug(botSlug, trimmedText, {
      conversationId: draftConversationId
    });

    // Log the conversation if we have a DB conversation
    if (conversationId) {
      try {
        await logMessage({
          conversationId,
          role: "USER",
          content: trimmedText
        });

        await logMessage({
          conversationId,
          role: "ASSISTANT",
          content: reply
        });
      } catch (err) {
        console.error("[Meta][FB] Failed to log messages", {
          conversationId,
          error: err
        });
      }
    }

    await sendFacebookTextMessage({
      pageId,
      accessToken: pageAccessToken,
      recipientId: userId,
      text: reply
    });

    console.log("[Meta][FB] Reply sent", {
      pageId,
      botSlug,
      userId
    });
  } catch (err) {
    console.error("[Meta][FB] Error handling message", {
      pageId,
      botSlug,
      userId,
      error: err
    });
  }
}

/**
 * Instagram DM handler.
 * - Same rate limiting + memory behavior as Facebook and other channels.
 */
export async function handleInstagramMessageEvent(params: {
  igBusinessId: string;
  userId: string;
  text: string;
}): Promise<void> {
  const { igBusinessId, userId, text } = params;
  const trimmedText = (text || "").trim();
  if (!trimmedText) {
    console.warn("[Meta][IG] Ignoring empty message", { igBusinessId, userId });
    return;
  }

  const botSlug = await getBotSlugByInstagramBusinessId(igBusinessId);
  if (!botSlug) {
    console.warn("[Meta][IG] No bot configured for igBusinessId", { igBusinessId });
    return;
  }

  const botConfig = await getBotConfigBySlug(botSlug);
  if (!botConfig) {
    console.warn("[Meta][IG] Bot config missing for slug", { botSlug });
    return;
  }

  const pageAccessToken =
    botConfig.channels?.instagram?.pageAccessToken || config.metaPageAccessToken;

  if (!pageAccessToken) {
    console.error("[Meta][IG] No page access token configured", {
      igBusinessId,
      botSlug
    });
    return;
  }

  // Create/attach conversation (DB bots only) BEFORE any reply decision
  const conversationId = await ensureMetaConversation({
    botId: botConfig.botId ?? null,
    channel: "INSTAGRAM",
    externalUserId: userId
  });
  const draftConversationId =
    conversationId ?? `meta:${botSlug}:instagram:${userId}`;

  // --- Rate limiting (shared across all channels via rateLimitService) ---
  let isLimited = false;
  let rateLimitMessage: string | null = null;

  if (conversationId) {
    const rate = await checkConversationRateLimit(conversationId);
    if (rate.isLimited) {
      isLimited = true;
      rateLimitMessage = buildRateLimitMessage(rate.retryAfterSeconds);
    }
  }

  if (isLimited && rateLimitMessage) {
    if (conversationId) {
      try {
        await logMessage({
          conversationId,
          role: "USER",
          content: trimmedText
        });
        await logMessage({
          conversationId,
          role: "ASSISTANT",
          content: rateLimitMessage
        });
      } catch (err) {
        console.error("[Meta][IG] Failed to log rate-limited messages", {
          conversationId,
          error: err
        });
      }
    }

    try {
      await sendInstagramTextMessage({
        igBusinessId,
        accessToken: pageAccessToken,
        recipientId: userId,
        text: rateLimitMessage
      });

      console.log("[Meta][IG] Rate limit message sent", {
        igBusinessId,
        botSlug,
        userId
      });
    } catch (err) {
      console.error("[Meta][IG] Error sending rate limit message", {
        igBusinessId,
        botSlug,
        userId,
        error: err
      });
    }

    return;
  }

  // --- Not rate-limited → normal AI flow with memory ---
  try {
    console.log("[Meta][IG] Incoming message", {
      igBusinessId,
      botSlug,
      userId,
      text: trimmedText
    });

    const reply = await generateBotReplyForSlug(botSlug, trimmedText, {
      conversationId: draftConversationId
    });

    if (conversationId) {
      try {
        await logMessage({
          conversationId,
          role: "USER",
          content: trimmedText
        });

        await logMessage({
          conversationId,
          role: "ASSISTANT",
          content: reply
        });
      } catch (err) {
        console.error("[Meta][IG] Failed to log messages", {
          conversationId,
          error: err
        });
      }
    }

    await sendInstagramTextMessage({
      igBusinessId,
      accessToken: pageAccessToken,
      recipientId: userId,
      text: reply
    });

    console.log("[Meta][IG] Reply sent", {
      igBusinessId,
      botSlug,
      userId
    });
  } catch (err) {
    console.error("[Meta][IG] Error handling message", {
      igBusinessId,
      botSlug,
      userId,
      error: err
    });
  }
}
