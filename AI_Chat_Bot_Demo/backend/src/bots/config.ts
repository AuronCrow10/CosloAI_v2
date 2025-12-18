// bots/config.ts

import { prisma } from "../prisma/prisma";
import { Bot as DbBot, BotChannel, ChannelType } from "@prisma/client";

// Base booking config, extended with optional advanced fields.
// Static demo bots can omit advanced fields; DB bots will have them filled.
export type BookingConfig =
  | { enabled: false }
  | {
      enabled: true;
      provider: "google_calendar";
      calendarId: string;
      timeZone: string;
      defaultDurationMinutes: number;

      // Advanced booking rules (optional, normalized downstream)
      minLeadHours?: number | null;
      maxAdvanceDays?: number | null;

      // Reminder timing (optional, normalized downstream)
      reminderWindowHours?: number | null;
      reminderMinLeadHours?: number | null;

      // Email toggles
      bookingConfirmationEmailEnabled?: boolean;
      bookingReminderEmailEnabled?: boolean;

      // Email templates (optional)
      bookingConfirmationSubjectTemplate?: string | null;
      bookingReminderSubjectTemplate?: string | null;
      bookingConfirmationBodyTextTemplate?: string | null;
      bookingReminderBodyTextTemplate?: string | null;
      bookingConfirmationBodyHtmlTemplate?: string | null;
      bookingReminderBodyHtmlTemplate?: string | null;

      // Booking fields for this bot
      requiredFields?: string[];
      customFields?: string[];
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
  id: string;
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
    id: "1",
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
      // Advanced options omitted for static demo → normalized later with defaults
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

// --- Helper: booking fields ---

const BASE_BOOKING_FIELDS = [
  "name",
  "email",
  "phone",
  "service",
  "datetime"
];

function computeBookingFields(
  dbFields?: string[] | null
): { required: string[]; custom: string[] } {
  const set = new Set<string>();

  // From DB config (if any)
  for (const raw of dbFields || []) {
    const trimmed = raw.trim();
    if (trimmed) set.add(trimmed);
  }

  // Always ensure base fields exist
  for (const base of BASE_BOOKING_FIELDS) {
    set.add(base);
  }

  const required = Array.from(set);
  const custom = required.filter(
    (f) => !BASE_BOOKING_FIELDS.includes(f)
  );

  return { required, custom };
}

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

  const { required, custom } = computeBookingFields(
    // this field is added in the updated Prisma schema
    (dbBot as any).bookingRequiredFields ?? undefined
  );

  return {
    enabled: true,
    provider: "google_calendar",
    calendarId: dbBot.calendarId,
    timeZone: dbBot.timeZone,
    defaultDurationMinutes: dbBot.defaultDurationMinutes,

    // Advanced rules (may be null in DB, normalized downstream)
    minLeadHours: (dbBot as any).bookingMinLeadHours ?? null,
    maxAdvanceDays: (dbBot as any).bookingMaxAdvanceDays ?? null,
    reminderWindowHours: (dbBot as any).bookingReminderWindowHours ?? null,
    reminderMinLeadHours:
      (dbBot as any).bookingReminderMinLeadHours ?? null,

    // Email toggles + templates (from DB)
    bookingConfirmationEmailEnabled:
      (dbBot as any).bookingConfirmationEmailEnabled ?? true,
    bookingReminderEmailEnabled:
      (dbBot as any).bookingReminderEmailEnabled ?? true,

    bookingConfirmationSubjectTemplate:
      (dbBot as any).bookingConfirmationSubjectTemplate ?? null,
    bookingReminderSubjectTemplate:
      (dbBot as any).bookingReminderSubjectTemplate ?? null,

    bookingConfirmationBodyTextTemplate:
      (dbBot as any).bookingConfirmationBodyTextTemplate ?? null,
    bookingReminderBodyTextTemplate:
      (dbBot as any).bookingReminderBodyTextTemplate ?? null,

    bookingConfirmationBodyHtmlTemplate:
      (dbBot as any).bookingConfirmationBodyHtmlTemplate ?? null,
    bookingReminderBodyHtmlTemplate:
      (dbBot as any).bookingReminderBodyHtmlTemplate ?? null,

    requiredFields: required,
    customFields: custom
  };
}

function mapDbBotToDemoConfig(
  dbBot: DbBot & { channels: BotChannel[] }
): DemoBotConfig {
  return {
    id: dbBot.id,
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
