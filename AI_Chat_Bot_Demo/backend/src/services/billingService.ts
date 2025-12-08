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
  | "CALENDAR";

type BotFeatureFlags = {
  useDomainCrawler: boolean;
  usePdfCrawler: boolean;
  channelWeb: boolean;
  channelWhatsapp: boolean;
  channelMessenger: boolean;
  channelInstagram: boolean;
  useCalendar: boolean;
};

const FEATURE_CODE_BY_BOT_FIELD: Record<keyof BotFeatureFlags, FeatureCode> = {
  useDomainCrawler: "DOMAIN_CRAWLER",
  usePdfCrawler: "PDF_CRAWLER",
  channelWeb: "CHANNEL_WEB",
  channelWhatsapp: "WHATSAPP",
  channelMessenger: "MESSENGER",
  channelInstagram: "INSTAGRAM",
  useCalendar: "CALENDAR"
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

  if (featureCodes.length === 0) {
    throw new Error("Cannot compute price: no billable features enabled for bot.");
  }

  const featurePrices = await prisma.featurePrice.findMany({
    where: {
      code: { in: featureCodes },
      isActive: true
    }
  });

  if (featurePrices.length !== featureCodes.length) {
    const foundCodes = new Set(featurePrices.map((fp) => fp.code));
    const missing = featureCodes.filter((code) => !foundCodes.has(code));
    throw new Error(
      `Missing FeaturePrice configuration for codes: ${missing.join(", ")}`
    );
  }

  // Ensure consistent currency
  const currency = featurePrices[0].currency;
  const mismatched = featurePrices.find((fp) => fp.currency !== currency);
  if (mismatched) {
    throw new Error(
      "Inconsistent FeaturePrice currency configuration for enabled bot features."
    );
  }

  const lineItemsForUi: PricingFeatureLineItem[] = featurePrices.map((fp) => ({
    code: fp.code as FeatureCode,
    label: fp.label,
    monthlyAmountCents: fp.monthlyAmountCents,
    monthlyAmountFormatted: formatAmount(fp.monthlyAmountCents, fp.currency),
    currency: fp.currency,
    stripePriceId: fp.stripePriceId
  }));

  const totalAmountCents = featurePrices.reduce(
    (sum, fp) => sum + fp.monthlyAmountCents,
    0
  );
  const totalAmountFormatted = formatAmount(totalAmountCents, currency);

  const lineItemsForStripe = featurePrices.map((fp) => {
    if (!fp.stripePriceId) {
      throw new Error(
        `FeaturePrice ${fp.code} is active but has no stripePriceId configured.`
      );
    }
    return {
      price: fp.stripePriceId,
      quantity: 1
    };
  });

  return {
    lineItemsForStripe,
    lineItemsForUi,
    totalAmountCents,
    totalAmountFormatted,
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
  if (!bot.subscription) return; // no subscription to update

  // Compute desired feature prices
  const pricing = await computeBotPricingForBot({
    useDomainCrawler: bot.useDomainCrawler,
    usePdfCrawler: bot.usePdfCrawler,
    channelWeb: bot.channelWeb,
    channelWhatsapp: bot.channelWhatsapp,
    channelMessenger: bot.channelMessenger,
    channelInstagram: bot.channelInstagram,
    useCalendar: bot.useCalendar
  });

  const stripeSubId = bot.subscription.stripeSubscriptionId;

  // Load Stripe subscription items
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const existingItems = stripeSub.items.data;

  // Load plan info (if any) from our DB to know the plan priceId
  const dbSub = await prisma.subscription.findUnique({
    where: { id: bot.subscription.id },
    include: { usagePlan: true }
  });

  const planPriceId: string | null =
    dbSub?.usagePlan?.stripePriceId ?? null;

  const featurePriceIds = pricing.lineItemsForStripe.map((li) => li.price);
  const featurePriceIdSet = new Set(featurePriceIds);

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];

  // 1) Keep / remove existing *feature* items, but preserve the plan item
  for (const item of existingItems) {
    const priceId = item.price.id;

    // Plan item: keep as-is (we don't manage it here)
    if (planPriceId && priceId === planPriceId) {
      items.push({
        id: item.id,
        quantity: item.quantity ?? 1 // keep current qty (usually 1)
      });
      continue;
    }

    // Feature item: keep if still desired, else delete
    if (featurePriceIdSet.has(priceId)) {
      items.push({
        id: item.id,
        price: priceId,
        quantity: 1
      });
    } else {
      items.push({
        id: item.id,
        deleted: true
      });
    }
  }

  // 2) Add new feature price items not present yet
  const existingFeaturePriceSet = new Set(
    existingItems
      .map((i) => i.price.id)
      .filter((pid) => !planPriceId || pid !== planPriceId)
  );

  for (const priceId of featurePriceIds) {
    if (!existingFeaturePriceSet.has(priceId)) {
      items.push({
        price: priceId,
        quantity: 1
      });
    }
  }

  // 3) Update subscription on Stripe with proration
  const updatedStripeSub = await stripe.subscriptions.update(stripeSubId, {
    items,
    proration_behavior: prorationBehavior,
    metadata: {
      botId: bot.id,
      userId: String(bot.userId)
    }
  });

  const primaryItem = updatedStripeSub.items.data[0];
  const currency = primaryItem?.price?.currency ?? pricing.currency;

  const compactPlanSnapshot = {
    f: pricing.featureCodes,
    fp: pricing.totalAmountCents,
    // plan info is stored separately on Subscription via usagePlanId
    c: currency
  };

  await prisma.subscription.update({
    where: { id: bot.subscription.id },
    data: {
      currency,
      planSnapshotJson: compactPlanSnapshot
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

  // Compute current features pricing to keep snapshot consistent
  const featurePricing = await computeBotPricingForBot({
    useDomainCrawler: bot.useDomainCrawler,
    usePdfCrawler: bot.usePdfCrawler,
    channelWeb: bot.channelWeb,
    channelWhatsapp: bot.channelWhatsapp,
    channelMessenger: bot.channelMessenger,
    channelInstagram: bot.channelInstagram,
    useCalendar: bot.useCalendar
  });

  // Currency consistency between features and plan
  if (featurePricing.currency !== newPlan.currency) {
    throw new Error(
      `Currency mismatch between features (${featurePricing.currency}) and plan (${newPlan.currency})`
    );
  }

  // Load Stripe subscription to manipulate items
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const existingItems = stripeSub.items.data;

  const oldPlanPriceId: string | null =
    dbSub.usagePlan?.stripePriceId ?? null;

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];

  for (const item of existingItems) {
    const priceId = item.price.id;

    // Old plan item: delete it
    if (oldPlanPriceId && priceId === oldPlanPriceId) {
      items.push({
        id: item.id,
        deleted: true
      });
      continue;
    }

    // Feature item (or any non-plan item): keep as-is
    items.push({
      id: item.id,
      price: priceId,
      quantity: item.quantity ?? 1
    });
  }

  // Add new plan item
  items.push({
    price: newPlan.stripePriceId,
    quantity: 1
  });

  // Update subscription on Stripe with proration
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
  const currency = primaryItem?.price?.currency ?? featurePricing.currency;

  const totalAmountCents =
    featurePricing.totalAmountCents + newPlan.monthlyAmountCents;

  const compactPlanSnapshot = {
    f: featurePricing.featureCodes,           // feature codes
    fp: featurePricing.totalAmountCents,      // features amount
    p: newPlan.code,                          // plan code
    pt: newPlan.monthlyAmountCents,           // plan amount
    t: totalAmountCents,                      // total
    c: currency                               // currency
  };

  // Persist new plan + snapshot on our side
  await prisma.subscription.update({
    where: { id: dbSub.id },
    data: {
      usagePlanId: newPlan.id,
      currency,
      planSnapshotJson: compactPlanSnapshot
    }
  });
}
