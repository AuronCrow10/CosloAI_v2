import { config } from "../config";
import {
  getBotConfigBySlug,
  getBotSlugByFacebookPageId,
  getBotSlugByInstagramBusinessId
} from "../bots/config";
import { generateBotReplyForSlug } from "./chatService";
import { sendFacebookTextMessage, sendInstagramTextMessage } from "../meta/client";

export async function handleFacebookMessageEvent(params: {
  pageId: string;
  userId: string;
  text: string;
}): Promise<void> {
  const { pageId, userId, text } = params;

  // ⬅️ NOW ASYNC
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

  try {
    console.log("[Meta][FB] Incoming message", {
      pageId,
      botSlug,
      userId,
      text
    });

    const reply = await generateBotReplyForSlug(botSlug, text);

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

export async function handleInstagramMessageEvent(params: {
  igBusinessId: string;
  userId: string;
  text: string;
}): Promise<void> {
  const { igBusinessId, userId, text } = params;

  // ⬅️ NOW ASYNC
  const botSlug = await getBotSlugByInstagramBusinessId(igBusinessId);
  if (!botSlug) {
    console.warn("[Meta][IG] No bot configured for igBusinessId", { igBusinessId });
    return;
  }

  // ⬅️ ALSO ASYNC
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

  try {
    console.log("[Meta][IG] Incoming message", {
      igBusinessId,
      botSlug,
      userId,
      text
    });

    const reply = await generateBotReplyForSlug(botSlug, text);

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
