"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeWebhookHandler = stripeWebhookHandler;
const prisma_1 = require("../prisma/prisma");
const billingService_1 = require("../services/billingService");
const config_1 = require("../config");
function parsePlanSnapshot(metadata) {
    const raw = metadata?.planSnapshot;
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function stripeWebhookHandler(req, res) {
    if (!billingService_1.stripe || !config_1.config.stripeWebhookSecret) {
        return res.sendStatus(200);
    }
    const sig = req.headers["stripe-signature"];
    if (!sig) {
        return res.sendStatus(400);
    }
    let event;
    try {
        event = billingService_1.stripe.webhooks.constructEvent(req.body, sig, config_1.config.stripeWebhookSecret);
    }
    catch (err) {
        console.error("Stripe webhook signature verification failed", err);
        return res.sendStatus(400);
    }
    try {
        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object;
                const botId = session.metadata?.botId;
                if (!botId)
                    break;
                const subscriptionId = session.subscription;
                const customerId = session.customer;
                if (!subscriptionId || !customerId)
                    break;
                // Fetch subscription to get price/currency info
                const sub = await billingService_1.stripe.subscriptions.retrieve(subscriptionId, {
                    expand: ["items.data.price"]
                });
                const primaryItem = sub.items.data[0];
                const stripePriceId = primaryItem?.price?.id ?? "";
                const currency = primaryItem?.price?.currency ?? session.currency ?? "eur";
                const planSnapshot = parsePlanSnapshot(session.metadata || null);
                await prisma_1.prisma.subscription.upsert({
                    where: { botId },
                    create: {
                        botId,
                        stripeCustomerId: customerId,
                        stripeSubscriptionId: subscriptionId,
                        stripePriceId,
                        status: "ACTIVE",
                        currency,
                        planSnapshotJson: planSnapshot ?? undefined
                    },
                    update: {
                        stripeCustomerId: customerId,
                        stripeSubscriptionId: subscriptionId,
                        stripePriceId,
                        status: "ACTIVE",
                        currency,
                        planSnapshotJson: planSnapshot ?? undefined
                    }
                });
                await prisma_1.prisma.bot.update({
                    where: { id: botId },
                    data: { status: "ACTIVE" }
                });
                break;
            }
            case "customer.subscription.updated":
            case "customer.subscription.deleted": {
                const sub = event.data.object;
                const stripeSubscriptionId = sub.id;
                const dbSub = await prisma_1.prisma.subscription.findFirst({
                    where: { stripeSubscriptionId }
                });
                if (!dbSub)
                    break;
                const statusMap = {
                    active: "ACTIVE",
                    past_due: "PAST_DUE",
                    canceled: "CANCELED",
                    incomplete: "INCOMPLETE",
                    incomplete_expired: "INCOMPLETE_EXPIRED",
                    trialing: "TRIALING",
                    unpaid: "UNPAID"
                };
                const status = (statusMap[sub.status] ?? "ACTIVE");
                await prisma_1.prisma.subscription.update({
                    where: { id: dbSub.id },
                    data: {
                        status,
                        currency: sub.items.data[0]?.price?.currency ?? dbSub.currency
                    }
                });
                let botStatus;
                if (status === "ACTIVE" || status === "TRIALING") {
                    botStatus = "ACTIVE";
                }
                else if (status === "CANCELED") {
                    // Manteniamo CANCELED per i bot con abbonamento terminato
                    botStatus = "CANCELED";
                }
                else {
                    botStatus = "SUSPENDED";
                }
                await prisma_1.prisma.bot.update({
                    where: { id: dbSub.botId },
                    data: { status: botStatus }
                });
                break;
            }
            case "invoice.payment_succeeded": {
                const invoice = event.data.object;
                const stripeCustomerId = typeof invoice.customer === "string"
                    ? invoice.customer
                    : invoice.customer?.id ?? "";
                const stripeSubscriptionId = invoice.subscription;
                const stripeInvoiceId = invoice.id;
                const stripePaymentIntentId = invoice.payment_intent;
                const amountCents = invoice.amount_paid;
                const currency = invoice.currency;
                // Use the denormalized fields on the invoice (no need to expand customer)
                const billingEmail = invoice.customer_email ?? undefined;
                const billingName = invoice.customer_name ?? undefined;
                const billingAddress = invoice.customer_address ?? null;
                const firstLine = invoice.lines.data[0];
                const period = firstLine?.period;
                const periodStart = period?.start
                    ? new Date(period.start * 1000)
                    : null;
                const periodEnd = period?.end ? new Date(period.end * 1000) : null;
                // Identify bot via subscription record
                let botId;
                if (stripeSubscriptionId) {
                    const dbSub = await prisma_1.prisma.subscription.findFirst({
                        where: { stripeSubscriptionId }
                    });
                    botId = dbSub?.botId;
                }
                if (!botId) {
                    console.warn("invoice.payment_succeeded without identifiable botId", stripeInvoiceId);
                    break;
                }
                await prisma_1.prisma.payment.create({
                    data: {
                        botId,
                        stripeCustomerId,
                        stripeSubscriptionId: stripeSubscriptionId ?? undefined,
                        stripeInvoiceId,
                        stripePaymentIntentId: stripePaymentIntentId ?? undefined,
                        amountCents,
                        currency,
                        status: invoice.status ?? "succeeded",
                        billingEmail,
                        billingName,
                        // store whatever Stripe gives us for address (can be null)
                        billingAddressJson: billingAddress
                            ? billingAddress
                            : undefined,
                        periodStart: periodStart ?? undefined,
                        periodEnd: periodEnd ?? undefined
                    }
                });
                break;
            }
            case "invoice.payment_failed": {
                const invoice = event.data.object;
                const stripeCustomerId = typeof invoice.customer === "string"
                    ? invoice.customer
                    : invoice.customer?.id ?? "";
                const stripeSubscriptionId = invoice.subscription;
                let botId;
                if (stripeSubscriptionId) {
                    const dbSub = await prisma_1.prisma.subscription.findFirst({
                        where: { stripeSubscriptionId }
                    });
                    botId = dbSub?.botId;
                }
                if (!botId) {
                    console.warn("invoice.payment_failed without identifiable botId", invoice.id);
                    break;
                }
                await prisma_1.prisma.payment.create({
                    data: {
                        botId,
                        stripeCustomerId,
                        stripeSubscriptionId: stripeSubscriptionId ?? undefined,
                        stripeInvoiceId: invoice.id,
                        stripePaymentIntentId: invoice.payment_intent ?? undefined,
                        amountCents: invoice.amount_due,
                        currency: invoice.currency,
                        status: "failed"
                    }
                });
                // You might later want to suspend bot here if repeated failures happen.
                break;
            }
            default:
                break;
        }
    }
    catch (err) {
        console.error("Error processing Stripe webhook event", err);
    }
    return res.sendStatus(200);
}
