// services/billingService.ts
import Stripe from "stripe";
import { prisma } from "../prisma/prisma";
import { config } from "../config";

export const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, { apiVersion: "2024-06-20" })
  : null;

// ---- Feature-based pricing types & helpers ----

export type FeatureCode =
  | "DOMAIN_CRAWLER"
  | "PDF_CRAWLER"
  | "CHANNEL_WEB"
  | "WHATSAPP"
  | "MESSENGER"
  | "INSTAGRAM"
  | "CALENDAR"
  | "LEAD_WHATSAPP_200"
  | "LEAD_WHATSAPP_500"
  | "LEAD_WHATSAPP_1000";

type BotFeatureFlags = {
  useDomainCrawler: boolean;
  usePdfCrawler: boolean;
  channelWeb: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  useCalendar: boolean;
  leadWhatsappMessages200: boolean;
  leadWhatsappMessages500: boolean;
  leadWhatsappMessages1000: boolean;
};

const FEATURE_CODE_BY_BOT_FIELD: Record<keyof BotFeatureFlags, FeatureCode> = {
  useDomainCrawler: "DOMAIN_CRAWLER",
  usePdfCrawler: "PDF_CRAWLER",
  channelWeb: "CHANNEL_WEB",
  channelWhatsapp: "WHATSAPP",
  channelMessenger: "MESSENGER",
  channelInstagram: "INSTAGRAM",
  useCalendar: "CALENDAR",
  leadWhatsappMessages200: "LEAD_WHATSAPP_200",
  leadWhatsappMessages500: "LEAD_WHATSAPP_500",
  leadWhatsappMessages1000: "LEAD_WHATSAPP_1000"
};

export interface PricingFeatureLineItem {
  code: FeatureCode;
  label: string;
  monthlyAmountCents: number;
  monthlyAmountFormatted: string;
  currency: string;
  stripePriceId?: string | null;
}

export interface BotPricingResult {
  lineItemsForStripe: { price: string; quantity: number }[]; // one Stripe price per feature
  lineItemsForUi: PricingFeatureLineItem[];
  totalAmountCents: number;
  totalAmountFormatted: string;
  currency: string;
  featureCodes: FeatureCode[];
}

function formatAmount(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(amountCents / 100);
}

function getEnabledFeatureCodes(bot: BotFeatureFlags): FeatureCode[] {
  const enabled: FeatureCode[] = [];
  (Object.keys(FEATURE_CODE_BY_BOT_FIELD) as (keyof BotFeatureFlags)[]).forEach(
    (field) => {
      if (bot[field]) {
        enabled.push(FEATURE_CODE_BY_BOT_FIELD[field]);
      }
    }
  );
  return enabled;
}

/**
 * Main pricing function: single source of truth.
 * Given a set of feature flags, loads FeaturePrice rows from DB and returns:
 *  - per-feature UI breakdown
 *  - Stripe line_items (one per feature)
 *  - total amount & currency
 *
 * NOTE: this is *only* features price. UsagePlan price is added separately.
 */
export async function computeBotPricingForBot(
  bot: BotFeatureFlags
): Promise<BotPricingResult> {
  const featureCodes = getEnabledFeatureCodes(bot);

  // Feature pricing is removed. Features are included in plans.
  // We keep the return shape so the rest of the codebase doesn't break.
  const currency = "eur"; // only used for formatting "0.00"; plan currency is handled elsewhere now.

  return {
    lineItemsForStripe: [],
    lineItemsForUi: [],
    totalAmountCents: 0,
    totalAmountFormatted: formatAmount(0, currency),
    currency,
    featureCodes
  };
}

/**
 * LEGACY: flat plan, kept so older code keeps compiling.
 * New code should use `computeBotPricingForBot` instead.
 */
export function computeBotPrice(bot: {
  useDomainCrawler: boolean;
  usePdfCrawler: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  useCalendar: boolean;
  leadWhatsappMessages200?: boolean | null;
  leadWhatsappMessages500?: boolean | null;
  leadWhatsappMessages1000?: boolean | null;
}) {
  // Simple model: one flat plan
  if (!config.stripePriceIdBasic) {
    throw new Error("STRIPE_PRICE_ID_BASIC not configured");
  }

  return {
    priceId: config.stripePriceIdBasic,
    amountDescription: "€29.00 / month"
  };
}

/*
Example (for your own sanity checks):

const exampleBot: BotFeatureFlags = {
  useDomainCrawler: true,
  usePdfCrawler: false,
  channelWeb: true,
  channelWhatsapp: true,
  channelMessenger: false,
  channelInstagram: false,
  useCalendar: false
};

computeBotPricingForBot(exampleBot) =>
  totalAmountCents = sum of DOMAIN_CRAWLER + CHANNEL_WEB + WHATSAPP prices.
*/

type BotWithSubscription = {
  id: string;
  userId: string;
  useDomainCrawler: boolean;
  usePdfCrawler: boolean;
  channelWeb: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  useCalendar: boolean;
  leadWhatsappMessages200?: boolean | null;
  leadWhatsappMessages500?: boolean | null;
  leadWhatsappMessages1000?: boolean | null;
  subscription: {
    id: string;
    stripeSubscriptionId: string;
  } | null;
};

/**
 * Sync Stripe subscription prices with the bot's current feature flags.
 *
 * - Uses computeBotPricingForBot as SSoT for *feature* prices.
 * - Uses proration_behavior: "create_prorations".
 *
 * IMPORTANT with plans:
 *  We keep the UsagePlan Stripe price item untouched and only
 *  add/remove feature price items.
 */
export async function updateBotSubscriptionForFeatureChange(
  bot: BotWithSubscription,
  prorationBehavior: Stripe.SubscriptionUpdateParams.ProrationBehavior = "create_prorations"
) {
  if (!stripe) return;
  if (!bot.subscription) return;

  const stripeSubId = bot.subscription.stripeSubscriptionId;

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const existingItems = stripeSub.items.data;

  const dbSub = await prisma.subscription.findUnique({
    where: { id: bot.subscription.id },
    include: { usagePlan: true }
  });

  const planPriceId: string | null = dbSub?.usagePlan?.stripePriceId ?? null;

  // If we can't identify the plan item, do nothing (safer than deleting unknown items).
  if (!planPriceId) return;

  const hasNonPlanItems = existingItems.some((i) => i.price.id !== planPriceId);
  if (!hasNonPlanItems) {
    // Already plan-only; no Stripe update needed.
    return;
  }

  const items: Stripe.SubscriptionUpdateParams.Item[] = existingItems.map((item) => {
    if (item.price.id === planPriceId) {
      return { id: item.id, quantity: item.quantity ?? 1 };
    }
    return { id: item.id, deleted: true };
  });

  await stripe.subscriptions.update(stripeSubId, {
    items,
    proration_behavior: prorationBehavior,
    metadata: { botId: bot.id, userId: String(bot.userId) }
  });

  // snapshot: features are included => fp is always 0
  await prisma.subscription.update({
    where: { id: bot.subscription.id },
    data: {
      planSnapshotJson: {
        f: [],  // optional: keep feature codes if you want; fp is what matters
        fp: 0,
        c: dbSub!.currency || dbSub!.usagePlan?.currency || "eur"
      }
    }
  });
}



export async function updateBotSubscriptionForUsagePlanChange({
  botId,
  newUsagePlanId,
  prorationBehavior = "create_prorations"
}: {
  botId: string;
  newUsagePlanId: string;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
}) {
  if (!stripe) return;

  // Load bot with subscription + current usage plan
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: {
      subscription: {
        include: {
          usagePlan: true
        }
      }
    }
  });

  if (!bot || !bot.subscription) {
    throw new Error("Bot or subscription not found");
  }

  const dbSub = bot.subscription;
  const stripeSubId = dbSub.stripeSubscriptionId;

  // Load the new usage plan (must be active and have a Stripe price)
  const newPlan = await prisma.usagePlan.findFirst({
    where: {
      id: newUsagePlanId,
      isActive: true
    }
  });

  if (!newPlan) {
    throw new Error("Usage plan not found or inactive");
  }

  if (!newPlan.stripePriceId) {
    throw new Error(`Usage plan ${newPlan.code} has no Stripe price configured`);
  }

  // (Optional) keep feature codes in snapshot for UI/debug, but NO PRICING
  const featureCodes = getEnabledFeatureCodes(
    botToFeatureFlags({
      useDomainCrawler: bot.useDomainCrawler,
      usePdfCrawler: bot.usePdfCrawler,
      channelWeb: bot.channelWeb,
      channelWhatsapp: bot.channelWhatsapp,
      channelMessenger: bot.channelMessenger,
      channelInstagram: bot.channelInstagram,
      useCalendar: bot.useCalendar,
      leadWhatsappMessages200: (bot as any).leadWhatsappMessages200,
      leadWhatsappMessages500: (bot as any).leadWhatsappMessages500,
      leadWhatsappMessages1000: (bot as any).leadWhatsappMessages1000
    })
  );

  // Load Stripe subscription items
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const existingItems = stripeSub.items.data;

  // ✅ Plan-only billing:
  // delete EVERYTHING currently on the subscription (plan + any feature add-ons),
  // then add the new plan price as the only item.
  const items: Stripe.SubscriptionUpdateParams.Item[] = existingItems.map((item) => ({
    id: item.id,
    deleted: true
  }));

  items.push({
    price: newPlan.stripePriceId,
    quantity: 1
  });

  const updatedStripeSub = await stripe.subscriptions.update(stripeSubId, {
    items,
    proration_behavior: prorationBehavior,
    metadata: {
      botId: bot.id,
      userId: String(bot.userId),
      usagePlanId: newPlan.id
    }
  });

  const primaryItem = updatedStripeSub.items.data[0];
  const currency = primaryItem?.price?.currency ?? newPlan.currency;

  // ✅ total is PLAN ONLY
  const totalAmountCents = newPlan.monthlyAmountCents;

  const compactPlanSnapshot = {
    f: featureCodes,                 // optional: keep codes
    fp: 0,                           // ✅ feature price removed
    p: newPlan.code,
    pt: newPlan.monthlyAmountCents,
    t: totalAmountCents,
    c: currency
  };

  await prisma.subscription.update({
    where: { id: dbSub.id },
    data: {
      usagePlanId: newPlan.id,
      currency,
      planSnapshotJson: compactPlanSnapshot
    }
  });
}



export function botToFeatureFlags(bot: {
  useDomainCrawler: boolean;
  usePdfCrawler: boolean;
  channelWeb: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  useCalendar: boolean;
  leadWhatsappMessages200?: boolean | null;
  leadWhatsappMessages500?: boolean | null;
  leadWhatsappMessages1000?: boolean | null;
}): BotFeatureFlags {
  return {
    useDomainCrawler: bot.useDomainCrawler,
    usePdfCrawler: bot.usePdfCrawler,
    channelWeb: bot.channelWeb,
    channelWhatsapp: bot.channelWhatsapp,
    channelMessenger: bot.channelMessenger,
    channelInstagram: bot.channelInstagram,
    useCalendar: bot.useCalendar,
    leadWhatsappMessages200: !!bot.leadWhatsappMessages200,
    leadWhatsappMessages500: !!bot.leadWhatsappMessages500,
    leadWhatsappMessages1000: !!bot.leadWhatsappMessages1000
  };
}
