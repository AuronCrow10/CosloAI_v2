// services/pushNotificationService.ts

import axios from "axios";
import { prisma } from "../prisma/prisma";
import { ChannelType } from "@prisma/client";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type HumanConversationPushPayload = {
  conversationId: string;
  botId: string;
  botName: string;
  channel: ChannelType;
};

export type UsageAlertPushPayload = {
  botId: string;
  botName: string;
  threshold: number; // 50, 70, 90, 100
  percent: number;
  usedTokens: number;
  limitTokens: number;
};

function formatChannelLabel(channel: ChannelType): string {
  switch (channel) {
    case "WHATSAPP":
      return "WhatsApp";
    case "FACEBOOK":
      return "Facebook";
    case "INSTAGRAM":
      return "Instagram";
    case "WEB":
    default:
      return "Website widget";
  }
}

/**
 * Send a push notification to all registered devices for this user
 * when a conversation switches into HUMAN mode.
 */
export async function sendHumanConversationPush(
  userId: string,
  payload: HumanConversationPushPayload
): Promise<void> {
  console.log("[Push] HUMAN -> called for user", userId, "payload:", payload);

  const devices = await prisma.mobileDevice.findMany({
    where: { userId }
  });

  console.log("[Push] HUMAN -> found devices:", devices.length);

  if (!devices.length) {
    console.log("[Push] HUMAN -> no devices, abort");
    return;
  }

  const channelLabel = formatChannelLabel(payload.channel);

  const notifications = devices
    .map((device) => {
      const token = device.expoPushToken;
      if (!token) return null;

      // Expo tokens usually look like "ExponentPushToken[...]" or "ExpoPushToken[...]"
      if (
        !token.startsWith("ExponentPushToken") &&
        !token.startsWith("ExpoPushToken")
      ) {
        console.warn("[Push] HUMAN -> skipping invalid token", token);
        return null;
      }

      return {
        to: token,
        sound: "default" as const,
        title: "A conversation requires your attention",
        body: `${payload.botName} – new HUMAN conversation on ${channelLabel}`,
        data: {
          type: "HUMAN_CONVERSATION",
          conversationId: payload.conversationId,
          botId: payload.botId,
          channel: payload.channel
        }
      };
    })
    .filter(
      (n): n is {
        to: string;
        sound: "default";
        title: string;
        body: string;
        data: {
          type: "HUMAN_CONVERSATION";
          conversationId: string;
          botId: string;
          channel: ChannelType;
        };
      } => n !== null
    );

  console.log(
    "[Push] HUMAN -> notifications to send to:",
    notifications.map((n) => n.to)
  );

  if (!notifications.length) {
    console.log("[Push] HUMAN -> no valid notifications after filtering");
    return;
  }

  try {
    const resp = await axios.post(EXPO_PUSH_URL, notifications, {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    console.log(
      "[Push] HUMAN -> Expo response:",
      JSON.stringify(resp.data, null, 2)
    );
  } catch (err) {
    console.error("[Push] HUMAN -> Failed to send Expo push notifications", err);
  }
}

/**
 * Send a push notification to all registered devices for this user
 * when a bot crosses a plan-usage threshold (50/70/90/100%).
 */
export async function sendUsageAlertPushToUser(
  userId: string,
  payload: UsageAlertPushPayload
): Promise<void> {
  console.log("[Push] USAGE -> called for user", userId, "payload:", payload);

  const devices = await prisma.mobileDevice.findMany({
    where: { userId }
  });

  console.log("[Push] USAGE -> found devices:", devices.length);

  if (!devices.length) {
    console.log("[Push] USAGE -> no devices, abort");
    return;
  }

  const roundedPercent = Math.min(100, Math.round(payload.percent));

  let title = `Usage alert for ${payload.botName}`;
  let body: string;

  if (payload.threshold === 50) {
    body = `${payload.botName} has used about ${roundedPercent}% of its monthly plan.`;
  } else if (payload.threshold === 70) {
    body = `${payload.botName} is at roughly ${roundedPercent}% of its monthly plan.`;
  } else if (payload.threshold === 90) {
    body = `${payload.botName} is close to its monthly limit (${roundedPercent}%).`;
  } else {
    // 100
    body = `${payload.botName} has reached 100% of its monthly plan.`;
  }

  const notifications = devices
    .map((device) => {
      const token = device.expoPushToken;
      if (!token) return null;

      // Expo tokens usually look like "ExponentPushToken[...]" or "ExpoPushToken[...]"
      if (
        !token.startsWith("ExponentPushToken") &&
        !token.startsWith("ExpoPushToken")
      ) {
        console.warn("[Push] USAGE -> skipping invalid token", token);
        return null;
      }

      return {
        to: token,
        sound: "default" as const,
        title,
        body,
        data: {
          type: "USAGE_ALERT",
          botId: payload.botId,
          threshold: payload.threshold,
          percent: roundedPercent,
          usedTokens: payload.usedTokens,
          limitTokens: payload.limitTokens
        }
      };
    })
    .filter(
      (n): n is {
        to: string;
        sound: "default";
        title: string;
        body: string;
        data: {
          type: "USAGE_ALERT";
          botId: string;
          threshold: number;
          percent: number;
          usedTokens: number;
          limitTokens: number;
        };
      } => n !== null
    );

  console.log(
    "[Push] USAGE -> notifications to send to:",
    notifications.map((n) => n.to)
  );

  if (!notifications.length) {
    console.log("[Push] USAGE -> no valid notifications after filtering");
    return;
  }

  try {
    const resp = await axios.post(EXPO_PUSH_URL, notifications, {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    console.log(
      "[Push] USAGE -> Expo response:",
      JSON.stringify(resp.data, null, 2)
    );
  } catch (err) {
    console.error(
      "[Push] USAGE -> Failed to send Expo usage alert push notifications",
      err
    );
  }
}
