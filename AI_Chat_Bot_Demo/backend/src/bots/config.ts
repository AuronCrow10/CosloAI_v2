import { prisma } from "../prisma/prisma";
import { Bot as DbBot, BotChannel, ChannelType } from "@prisma/client";

// Booking config (already present)
export type BookingConfig =
  | { enabled: false }
  | {
      enabled: true;
      provider: "google_calendar";
      calendarId: string;
      timeZone: string;
      defaultDurationMinutes: number;
    };

// Channels config
export type WebChannelConfig = {
  enabled: boolean;
};

export type WhatsAppChannelConfig = {
  phoneNumberId: string;
};

export type FacebookChannelConfig = {
  pageId: string; // Facebook Page ID
  pageAccessToken?: string; // optional: per-bot page token
};

export type InstagramChannelConfig = {
  igBusinessId: string; // Instagram Business Account ID
  pageAccessToken?: string; // optional: per-bot page token
};

export type BotChannels = {
  web?: WebChannelConfig;
  whatsapp?: WhatsAppChannelConfig;
  facebook?: FacebookChannelConfig;
  instagram?: InstagramChannelConfig;
};

export type DemoBotConfig = {
  slug: string;
  name: string;
  knowledgeClientId: string | null;
  domain: string;
  systemPrompt: string;
  booking?: BookingConfig;
  channels?: BotChannels;
  description?: string;

  // NEW: for usage attribution
  ownerUserId?: string | null;
  botId?: string | null;
};

// --- HARDCODED DEMO BOTS (fallback) ---

const DEMO_BOTS: DemoBotConfig[] = [
  {
    slug: "cosmin-marica",
    name: "Cosmin Marica Full Stack Developer",
    knowledgeClientId: "fba15b42-da66-402f-84dc-13aafa6ddc38",
    domain: "cosminmarica.dev",
    systemPrompt:
      "You are the helpful assistant for Cosmin, a full stack web and blockchain developer. Answer only using information from the provided CONTEXT.",
    description: "Cosmin's Virtual AI Assistant",
    booking: {
      enabled: true,
      provider: "google_calendar",
      calendarId:
        "611eccf5c3e127d2498eee1f5d2dc33afdc8e550d31a1302328f5bd610c7daea@group.calendar.google.com",
      timeZone: "Europe/Rome",
      defaultDurationMinutes: 60
    },
    channels: {
      web: { enabled: true },
      whatsapp: {
        phoneNumberId: "885569401305770" // example
      },
      facebook: {
        pageId: "843684242170165"
      },
      instagram: {
        igBusinessId: "17841401887023191"
      }
    }
    // ownerUserId / botId are undefined for static demo bots
  }
  // ... other static demo bots if you want ...
];

// --- Helper: map DB Bot (+ channels) -> DemoBotConfig ---

function buildChannelsFromDb(
  dbBot: DbBot & { channels: BotChannel[] }
): BotChannels | undefined {
  const channels: BotChannels = {};

  if (dbBot.channelWeb) {
    channels.web = { enabled: true };
  }

  for (const ch of dbBot.channels) {
    if (ch.type === "WHATSAPP") {
      channels.whatsapp = {
        phoneNumberId: ch.externalId
      };
    } else if (ch.type === "FACEBOOK") {
      channels.facebook = {
        pageId: ch.externalId,
        pageAccessToken: ch.accessToken || undefined
      };
    } else if (ch.type === "INSTAGRAM") {
      channels.instagram = {
        igBusinessId: ch.externalId,
        pageAccessToken: ch.accessToken || undefined
      };
    }
  }

  return Object.keys(channels).length > 0 ? channels : undefined;
}

function buildBookingFromDb(dbBot: DbBot): BookingConfig | undefined {
  if (!dbBot.useCalendar) return { enabled: false };
  if (!dbBot.calendarId || !dbBot.timeZone || !dbBot.defaultDurationMinutes) {
    // Calendar feature flagged on but config incomplete → treat as disabled for safety
    return { enabled: false };
  }
  return {
    enabled: true,
    provider: "google_calendar",
    calendarId: dbBot.calendarId,
    timeZone: dbBot.timeZone,
    defaultDurationMinutes: dbBot.defaultDurationMinutes
  };
}

function mapDbBotToDemoConfig(
  dbBot: DbBot & { channels: BotChannel[] }
): DemoBotConfig {
  return {
    slug: dbBot.slug,
    name: dbBot.name,
    knowledgeClientId: dbBot.knowledgeClientId,
    domain: dbBot.domain || "",
    systemPrompt: dbBot.systemPrompt,
    description: dbBot.description || undefined,
    booking: buildBookingFromDb(dbBot),
    channels: buildChannelsFromDb(dbBot),

    // NEW: link back to DB entities for usage tracking
    ownerUserId: dbBot.userId,
    botId: dbBot.id
  };
}

// --- PUBLIC API ---

export async function getBotConfigBySlug(
  slug: string
): Promise<DemoBotConfig | null> {
  // 1) DB first
  const dbBot = await prisma.bot.findUnique({
    where: { slug },
    include: { channels: true }
  });

  if (dbBot) {
    return mapDbBotToDemoConfig(dbBot);
  }

  // 2) fallback to static DEMO_BOTS (for legacy/demo)
  const fallback = DEMO_BOTS.find((bot) => bot.slug === slug) ?? null;
  return fallback;
}

export type PublicBotConfig = Pick<
  DemoBotConfig,
  "slug" | "name" | "description"
>;

// Inverse lookups DB-first, then fallback to static DEMO_BOTS

export async function getBotSlugByFacebookPageId(
  pageId: string
): Promise<string | null> {
  const channel = await prisma.botChannel.findFirst({
    where: {
      type: "FACEBOOK",
      externalId: pageId
    },
    include: { bot: true }
  });

  if (channel?.bot) {
    return channel.bot.slug;
  }

  const bot = DEMO_BOTS.find(
    (b) =>
      b.channels?.facebook && b.channels.facebook.pageId === pageId
  );
  return bot ? bot.slug : null;
}

export async function getBotSlugByInstagramBusinessId(
  igBusinessId: string
): Promise<string | null> {
  const channel = await prisma.botChannel.findFirst({
    where: {
      type: "INSTAGRAM",
      externalId: igBusinessId
    },
    include: { bot: true }
  });

  if (channel?.bot) {
    return channel.bot.slug;
  }

  const bot = DEMO_BOTS.find(
    (b) =>
      b.channels?.instagram &&
      b.channels.instagram.igBusinessId === igBusinessId
  );
  return bot ? bot.slug : null;
}
