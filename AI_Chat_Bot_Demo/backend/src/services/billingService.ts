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
 * - Usa computeBotPricingForBot come SSoT.
 * - Usa proration_behavior: "create_prorations" => Stripe calcola
 *   automaticamente addebiti/crediti per il periodo rimanente.
 *
 * NOTA "no refunds":
 *  Non chiamiamo MAI stripe.refunds.create.
 *  Eventuali crediti da downgrade rimangono come credito Stripe
 *  e verranno usati per le prossime fatture, non rimborsati sulla carta.
 */
export async function updateBotSubscriptionForFeatureChange(
  bot: BotWithSubscription,
  prorationBehavior: Stripe.SubscriptionUpdateParams.ProrationBehavior = "create_prorations"
) {
  if (!stripe) return;
  if (!bot.subscription) return; // nessuna subscription da aggiornare

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

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"]
  });

  const existingItems = stripeSub.items.data;

  // Nuovi priceId desiderati (uno per feature)
  const newPriceIds = pricing.lineItemsForStripe.map((li) => li.price);
  const newPriceSet = new Set(newPriceIds);

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];

  // 1) Mantieni / rimuovi gli item esistenti
  for (const item of existingItems) {
    const priceId = item.price.id;
    if (newPriceSet.has(priceId)) {
      items.push({
        id: item.id,
        price: priceId,
        quantity: 1
      });
    } else {
      // feature rimossa -> elimina l'item
      items.push({
        id: item.id,
        deleted: true
      });
    }
  }

  // 2) Aggiungi item per priceId nuovi
  const existingPriceSet = new Set(existingItems.map((i) => i.price.id));
  for (const priceId of newPriceIds) {
    if (!existingPriceSet.has(priceId)) {
      items.push({
        price: priceId,
        quantity: 1
      });
    }
  }

  // 3) Aggiorna la subscription su Stripe con proration
  const updatedStripeSub = await stripe.subscriptions.update(stripeSubId, {
    items,
    proration_behavior: prorationBehavior,
    // metadata di comodo
    metadata: {
      botId: bot.id,
      userId: String(bot.userId)
    }
    // NOTA: non settiamo payment_behavior => default Stripe, niente refund automatico.
  });

  const primaryItem = updatedStripeSub.items.data[0];
  const currency = primaryItem?.price?.currency ?? pricing.currency;

  const compactPlanSnapshot = {
    f: pricing.featureCodes,
    t: pricing.totalAmountCents,
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