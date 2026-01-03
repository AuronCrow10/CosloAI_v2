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
 *
 * This assumes a MobileDevice model like:
 *
 * model MobileDevice {
 *   id            String   @id @default(cuid())
 *   userId        String
 *   user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
 *   expoPushToken String
 *   platform      String   // "ios" | "android"
 *   createdAt     DateTime @default(now())
 *   updatedAt     DateTime @updatedAt
 * }
 */
export async function sendHumanConversationPush(
  userId: string,
  payload: HumanConversationPushPayload
): Promise<void> {
  const devices = await prisma.mobileDevice.findMany({
    where: { userId }
  });

  if (!devices.length) {
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

  if (!notifications.length) {
    return;
  }

  try {
    // Expo supports sending an array of messages in one request
    await axios.post(EXPO_PUSH_URL, notifications, {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
  } catch (err) {
    console.error("Failed to send Expo push notifications", err);
  }
}
