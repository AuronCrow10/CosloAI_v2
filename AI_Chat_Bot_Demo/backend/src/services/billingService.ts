import Stripe from "stripe";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import {
  BillingTerm,
  getPlanTermPrice,
  normalizeBillingTerm
} from "./billingTerms";

export const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, { apiVersion: "2024-06-20" })
  : null;

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
  lineItemsForStripe: { price: string; quantity: number }[];
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

export function buildCompactPlanSnapshot(params: {
  featureCodes: FeatureCode[];
  usagePlan: any;
  billingTerm: BillingTerm;
  termAmountCents: number;
  monthlyEquivalentAmountCents: number;
  currency: string;
}) {
  return {
    f: params.featureCodes,
    fp: 0,
    p: params.usagePlan.code,
    pt: params.usagePlan.monthlyAmountCents,
    bt: params.billingTerm,
    tm: params.termAmountCents,
    mt: params.monthlyEquivalentAmountCents,
    t: params.monthlyEquivalentAmountCents,
    c: params.currency
  };
}

export async function computeBotPricingForBot(
  bot: BotFeatureFlags
): Promise<BotPricingResult> {
  const featureCodes = getEnabledFeatureCodes(bot);
  const currency = "eur";

  return {
    lineItemsForStripe: [],
    lineItemsForUi: [],
    totalAmountCents: 0,
    totalAmountFormatted: formatAmount(0, currency),
    currency,
    featureCodes
  };
}

export function computeBotPrice(_bot: {
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
  if (!config.stripePriceIdBasic) {
    throw new Error("STRIPE_PRICE_ID_BASIC not configured");
  }

  return {
    priceId: config.stripePriceIdBasic,
    amountDescription: "EUR 29.00 / month"
  };
}

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

export async function updateBotSubscriptionForFeatureChange(
  bot: BotWithSubscription,
  prorationBehavior: Stripe.SubscriptionUpdateParams.ProrationBehavior = "create_prorations"
) {
  if (!stripe) return;
  if (!bot.subscription) return;

  const stripeSubId = bot.subscription.stripeSubscriptionId;

  const dbSub = await prisma.subscription.findUnique({
    where: { id: bot.subscription.id },
    include: { usagePlan: true }
  });

  const featureCodes = getEnabledFeatureCodes(
    botToFeatureFlags({
      useDomainCrawler: bot.useDomainCrawler,
      usePdfCrawler: bot.usePdfCrawler,
      channelWeb: bot.channelWeb,
      channelWhatsapp: bot.channelWhatsapp,
      channelMessenger: bot.channelMessenger,
      channelInstagram: bot.channelInstagram,
      useCalendar: bot.useCalendar,
      leadWhatsappMessages200: bot.leadWhatsappMessages200,
      leadWhatsappMessages500: bot.leadWhatsappMessages500,
      leadWhatsappMessages1000: bot.leadWhatsappMessages1000
    })
  );

  const snapshotCurrency = dbSub?.currency || dbSub?.usagePlan?.currency || "eur";

  if (stripeSubId.startsWith("free_")) {
    await prisma.subscription.update({
      where: { id: bot.subscription.id },
      data: {
        planSnapshotJson: {
          f: featureCodes,
          fp: 0,
          c: snapshotCurrency
        }
      }
    });
    return;
  }

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const existingItems = stripeSub.items.data;
  const planPriceId: string | null = dbSub?.usagePlan?.stripePriceId ?? null;
  if (!planPriceId) return;

  const hasNonPlanItems = existingItems.some((i) => i.price.id !== planPriceId);
  if (!hasNonPlanItems) return;

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

  await prisma.subscription.update({
    where: { id: bot.subscription.id },
    data: {
      planSnapshotJson: {
        f: featureCodes,
        fp: 0,
        c: snapshotCurrency
      }
    }
  });
}

export async function updateBotSubscriptionForUsagePlanChange({
  botId,
  newUsagePlanId,
  billingTerm,
  prorationBehavior = "none",
  billingCycleAnchor = "now",
  resetUsageAnchor = true
}: {
  botId: string;
  newUsagePlanId: string;
  billingTerm: BillingTerm;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
  billingCycleAnchor?: Stripe.SubscriptionUpdateParams.BillingCycleAnchor;
  resetUsageAnchor?: boolean;
}) {
  if (!stripe) return;

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
  if (stripeSubId.startsWith("free_")) {
    throw new Error("Free plans do not have Stripe subscriptions.");
  }

  const newPlan = await prisma.usagePlan.findFirst({
    where: {
      id: newUsagePlanId,
      isActive: true
    }
  });

  if (!newPlan) {
    throw new Error("Usage plan not found or inactive");
  }

  const normalizedTerm = normalizeBillingTerm(billingTerm);
  const targetTermPrice = getPlanTermPrice(newPlan, normalizedTerm);
  const isPaidPlan = (newPlan.monthlyAmountCents ?? 0) > 0;

  if (isPaidPlan && !targetTermPrice.stripePriceId) {
    throw new Error(
      `Usage plan ${newPlan.code} has no Stripe price configured for ${normalizedTerm}`
    );
  }

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

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const items: Stripe.SubscriptionUpdateParams.Item[] = stripeSub.items.data.map(
    (item) => ({
      id: item.id,
      deleted: true
    })
  );

  items.push({
    price: targetTermPrice.stripePriceId || undefined,
    quantity: 1
  });

  const updatedStripeSub = await stripe.subscriptions.update(stripeSubId, {
    items,
    proration_behavior: prorationBehavior,
    billing_cycle_anchor: billingCycleAnchor,
    metadata: {
      botId: bot.id,
      userId: String(bot.userId),
      usagePlanId: newPlan.id,
      billingTerm: normalizedTerm
    }
  });

  const primaryItem = updatedStripeSub.items.data[0];
  const currency = primaryItem?.price?.currency ?? newPlan.currency;

  const compactPlanSnapshot = buildCompactPlanSnapshot({
    featureCodes,
    usagePlan: newPlan,
    billingTerm: normalizedTerm,
    termAmountCents: targetTermPrice.amountCents,
    monthlyEquivalentAmountCents:
      targetTermPrice.monthlyEquivalentAmountCents,
    currency
  });

  await prisma.subscription.update({
    where: { id: dbSub.id },
    data: {
      stripePriceId: targetTermPrice.stripePriceId ?? dbSub.stripePriceId,
      usagePlanId: newPlan.id,
      billingTerm: normalizedTerm,
      currency,
      planSnapshotJson: compactPlanSnapshot,
      usageAnchorAt: resetUsageAnchor ? new Date() : dbSub.usageAnchorAt,
      pendingUsagePlanId: null,
      pendingBillingTerm: null,
      pendingSwitchAt: null
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
