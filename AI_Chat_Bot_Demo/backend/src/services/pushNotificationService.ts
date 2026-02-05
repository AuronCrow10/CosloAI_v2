// services/pushNotificationService.ts

import axios from "axios";
import { DateTime } from "luxon";
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

export type BookingCreatedPushPayload = {
  botId: string;
  botName: string;
  start: string; // ISO datetime
  timeZone?: string | null;
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

function formatBookingDate(startIso: string, timeZone?: string | null): string {
  const dt = DateTime.fromISO(startIso, {
    zone: timeZone || "utc"
  });

  if (!dt.isValid) {
    return startIso;
  }

  return dt.toFormat("cccc, dd LLLL yyyy 'at' HH:mm");
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

/**
 * Send a push notification when a new booking is created via the assistant.
 */
export async function sendBookingCreatedPush(
  userId: string,
  payload: BookingCreatedPushPayload
): Promise<void> {
  console.log("[Push] BOOKING -> called for user", userId, "payload:", payload);

  const devices = await prisma.mobileDevice.findMany({
    where: { userId }
  });

  console.log("[Push] BOOKING -> found devices:", devices.length);

  if (!devices.length) {
    console.log("[Push] BOOKING -> no devices, abort");
    return;
  }

  const formattedDate = formatBookingDate(payload.start, payload.timeZone);
  const title = "New booking created";
  const body = `${payload.botName} has a new booking on ${formattedDate}`;

  const notifications = devices
    .map((device) => {
      const token = device.expoPushToken;
      if (!token) return null;

      if (
        !token.startsWith("ExponentPushToken") &&
        !token.startsWith("ExpoPushToken")
      ) {
        console.warn("[Push] BOOKING -> skipping invalid token", token);
        return null;
      }

      return {
        to: token,
        sound: "default" as const,
        title,
        body,
        data: {
          type: "BOOKING_CREATED",
          botId: payload.botId,
          start: payload.start
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
          type: "BOOKING_CREATED";
          botId: string;
          start: string;
        };
      } => n !== null
    );

  console.log(
    "[Push] BOOKING -> notifications to send to:",
    notifications.map((n) => n.to)
  );

  if (!notifications.length) {
    console.log("[Push] BOOKING -> no valid notifications after filtering");
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
      "[Push] BOOKING -> Expo response:",
      JSON.stringify(resp.data, null, 2)
    );
  } catch (err) {
    console.error(
      "[Push] BOOKING -> Failed to send Expo booking push notifications",
      err
    );
  }
}
