import { Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../prisma/prisma";
import { stripe } from "../services/billingService";
import { config } from "../config";

function parsePlanSnapshot(metadata: Stripe.Metadata | null | undefined) {
  const raw = metadata?.planSnapshot;
  if (!raw) return null;
  try {
    return JSON.parse(raw as string);
  } catch {
    return null;
  }
}

export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!stripe || !config.stripeWebhookSecret) {
    return res.sendStatus(200);
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.sendStatus(400);
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig as string,
      config.stripeWebhookSecret
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err);
    return res.sendStatus(400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const botId = session.metadata?.botId as string | undefined;
        if (!botId) break;

        const subscriptionId = session.subscription as string | null;
        const customerId = session.customer as string | null;

        if (!subscriptionId || !customerId) break;

        // Fetch subscription to get price/currency info
        const sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"]
        });

        const primaryItem = sub.items.data[0];
        const stripePriceId = primaryItem?.price?.id ?? "";
        const currency =
          primaryItem?.price?.currency ?? session.currency ?? "eur";

        const planSnapshot = parsePlanSnapshot(session.metadata || null);

        await prisma.subscription.upsert({
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

        await prisma.bot.update({
          where: { id: botId },
          data: { status: "ACTIVE" }
        });

        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeSubscriptionId = sub.id;
        const dbSub = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId }
        });
        if (!dbSub) break;

        const statusMap: Record<string, string> = {
          active: "ACTIVE",
          past_due: "PAST_DUE",
          canceled: "CANCELED",
          incomplete: "INCOMPLETE",
          incomplete_expired: "INCOMPLETE_EXPIRED",
          trialing: "TRIALING",
          unpaid: "UNPAID"
        };
        const status = (statusMap[sub.status] ?? "ACTIVE") as any;

        await prisma.subscription.update({
          where: { id: dbSub.id },
          data: {
            status,
            currency: sub.items.data[0]?.price?.currency ?? dbSub.currency
          }
        });

        let botStatus: "ACTIVE" | "SUSPENDED" | "CANCELED";

        if (status === "ACTIVE" || status === "TRIALING") {
          botStatus = "ACTIVE";
        } else if (status === "CANCELED") {
        // Manteniamo CANCELED per i bot con abbonamento terminato
          botStatus = "CANCELED";
        } else {
          botStatus = "SUSPENDED";
        }

        await prisma.bot.update({
          where: { id: dbSub.botId },
          data: { status: botStatus }
        });

        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;

        const stripeCustomerId =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id ?? "";
        const stripeSubscriptionId = invoice.subscription as string | null;
        const stripeInvoiceId = invoice.id;
        const stripePaymentIntentId = invoice.payment_intent as string | null;

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
        let botId: string | undefined;
        if (stripeSubscriptionId) {
          const dbSub = await prisma.subscription.findFirst({
            where: { stripeSubscriptionId }
          });
          botId = dbSub?.botId;
        }

        if (!botId) {
          console.warn(
            "invoice.payment_succeeded without identifiable botId",
            stripeInvoiceId
          );
          break;
        }

        await prisma.payment.create({
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
              ? (billingAddress as any)
              : undefined,
            periodStart: periodStart ?? undefined,
            periodEnd: periodEnd ?? undefined
          }
        });

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;

        const stripeCustomerId =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id ?? "";
        const stripeSubscriptionId = invoice.subscription as string | null;

        let botId: string | undefined;
        if (stripeSubscriptionId) {
          const dbSub = await prisma.subscription.findFirst({
            where: { stripeSubscriptionId }
          });
          botId = dbSub?.botId;
        }

        if (!botId) {
          console.warn(
            "invoice.payment_failed without identifiable botId",
            invoice.id
          );
          break;
        }

        await prisma.payment.create({
          data: {
            botId,
            stripeCustomerId,
            stripeSubscriptionId: stripeSubscriptionId ?? undefined,
            stripeInvoiceId: invoice.id,
            stripePaymentIntentId: (invoice.payment_intent as string) ?? undefined,
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
  } catch (err) {
    console.error("Error processing Stripe webhook event", err);
  }

  return res.sendStatus(200);
}
