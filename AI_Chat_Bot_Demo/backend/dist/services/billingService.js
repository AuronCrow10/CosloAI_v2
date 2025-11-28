"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripe = void 0;
exports.computeBotPricingForBot = computeBotPricingForBot;
exports.computeBotPrice = computeBotPrice;
exports.updateBotSubscriptionForFeatureChange = updateBotSubscriptionForFeatureChange;
const stripe_1 = __importDefault(require("stripe"));
const prisma_1 = require("../prisma/prisma");
const config_1 = require("../config");
exports.stripe = config_1.config.stripeSecretKey
    ? new stripe_1.default(config_1.config.stripeSecretKey, { apiVersion: "2024-06-20" })
    : null;
const FEATURE_CODE_BY_BOT_FIELD = {
    useDomainCrawler: "DOMAIN_CRAWLER",
    usePdfCrawler: "PDF_CRAWLER",
    channelWeb: "CHANNEL_WEB",
    channelWhatsapp: "WHATSAPP",
    channelMessenger: "MESSENGER",
    channelInstagram: "INSTAGRAM",
    useCalendar: "CALENDAR"
};
function formatAmount(amountCents, currency) {
    return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: currency.toUpperCase(),
        minimumFractionDigits: 2
    }).format(amountCents / 100);
}
function getEnabledFeatureCodes(bot) {
    const enabled = [];
    Object.keys(FEATURE_CODE_BY_BOT_FIELD).forEach((field) => {
        if (bot[field]) {
            enabled.push(FEATURE_CODE_BY_BOT_FIELD[field]);
        }
    });
    return enabled;
}
/**
 * Main pricing function: single source of truth.
 * Given a set of feature flags, loads FeaturePrice rows from DB and returns:
 *  - per-feature UI breakdown
 *  - Stripe line_items (one per feature)
 *  - total amount & currency
 */
async function computeBotPricingForBot(bot) {
    const featureCodes = getEnabledFeatureCodes(bot);
    if (featureCodes.length === 0) {
        throw new Error("Cannot compute price: no billable features enabled for bot.");
    }
    const featurePrices = await prisma_1.prisma.featurePrice.findMany({
        where: {
            code: { in: featureCodes },
            isActive: true
        }
    });
    if (featurePrices.length !== featureCodes.length) {
        const foundCodes = new Set(featurePrices.map((fp) => fp.code));
        const missing = featureCodes.filter((code) => !foundCodes.has(code));
        throw new Error(`Missing FeaturePrice configuration for codes: ${missing.join(", ")}`);
    }
    // Ensure consistent currency
    const currency = featurePrices[0].currency;
    const mismatched = featurePrices.find((fp) => fp.currency !== currency);
    if (mismatched) {
        throw new Error("Inconsistent FeaturePrice currency configuration for enabled bot features.");
    }
    const lineItemsForUi = featurePrices.map((fp) => ({
        code: fp.code,
        label: fp.label,
        monthlyAmountCents: fp.monthlyAmountCents,
        monthlyAmountFormatted: formatAmount(fp.monthlyAmountCents, fp.currency),
        currency: fp.currency,
        stripePriceId: fp.stripePriceId
    }));
    const totalAmountCents = featurePrices.reduce((sum, fp) => sum + fp.monthlyAmountCents, 0);
    const totalAmountFormatted = formatAmount(totalAmountCents, currency);
    const lineItemsForStripe = featurePrices.map((fp) => {
        if (!fp.stripePriceId) {
            throw new Error(`FeaturePrice ${fp.code} is active but has no stripePriceId configured.`);
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
function computeBotPrice(bot) {
    // Simple model: one flat plan
    if (!config_1.config.stripePriceIdBasic) {
        throw new Error("STRIPE_PRICE_ID_BASIC not configured");
    }
    return {
        priceId: config_1.config.stripePriceIdBasic,
        amountDescription: "€29.00 / month"
    };
}
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
async function updateBotSubscriptionForFeatureChange(bot, prorationBehavior = "create_prorations") {
    if (!exports.stripe)
        return;
    if (!bot.subscription)
        return; // nessuna subscription da aggiornare
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
    const stripeSub = await exports.stripe.subscriptions.retrieve(stripeSubId, {
        expand: ["items.data.price"]
    });
    const existingItems = stripeSub.items.data;
    // Nuovi priceId desiderati (uno per feature)
    const newPriceIds = pricing.lineItemsForStripe.map((li) => li.price);
    const newPriceSet = new Set(newPriceIds);
    const items = [];
    // 1) Mantieni / rimuovi gli item esistenti
    for (const item of existingItems) {
        const priceId = item.price.id;
        if (newPriceSet.has(priceId)) {
            items.push({
                id: item.id,
                price: priceId,
                quantity: 1
            });
        }
        else {
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
    const updatedStripeSub = await exports.stripe.subscriptions.update(stripeSubId, {
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
    await prisma_1.prisma.subscription.update({
        where: { id: bot.subscription.id },
        data: {
            currency,
            planSnapshotJson: compactPlanSnapshot
        }
    });
}
