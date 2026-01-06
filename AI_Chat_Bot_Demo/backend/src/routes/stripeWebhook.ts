import { Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../prisma/prisma";
import { stripe } from "../services/billingService";
import { config } from "../config";
import {
  computeCommissionCents,
  monthKeyForDate,
  validateReferralCode
} from "../services/referralService";

function parsePlanSnapshot(metadata: Stripe.Metadata | null | undefined) {
  const raw = metadata?.planSnapshot;
  if (!raw) return null;
  try {
    return JSON.parse(raw as string);
  } catch {
    return null;
  }
}

function isStripeSubActive(status: Stripe.Subscription.Status): boolean {
  return status === "active" || status === "trialing";
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
        const usagePlanId = session.metadata?.usagePlanId as string | undefined;

        await prisma.subscription.upsert({
          where: { botId },
          create: {
            botId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripePriceId,
            status: "ACTIVE",
            currency,
            planSnapshotJson: planSnapshot ?? undefined,
            usagePlanId: usagePlanId ?? undefined
          },
          update: {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripePriceId,
            status: "ACTIVE",
            currency,
            planSnapshotJson: planSnapshot ?? undefined,
            usagePlanId: usagePlanId ?? undefined
          }
        });

        await prisma.bot.update({
          where: { id: botId },
          data: { status: "ACTIVE" }
        });

        // ✅ Referral attribution creation (if referralCode metadata exists)
        const referralCode = (session.metadata?.referralCode as string | undefined)?.trim();
        if (referralCode) {
          const valid = await validateReferralCode(referralCode);
          if (valid) {
            const bot = await prisma.bot.findUnique({ where: { id: botId } });
            if (bot && valid.partnerUserId !== bot.userId) {
              const dbSub = await prisma.subscription.findUnique({ where: { botId } });

              // idempotent via unique stripeSubscriptionId
              await prisma.referralAttribution.upsert({
                where: { stripeSubscriptionId: subscriptionId },
                create: {
                  referralCodeId: valid.referralCodeId,
                  partnerId: valid.partnerId,
                  referredUserId: bot.userId,
                  botId,
                  subscriptionId: dbSub?.id,
                  stripeCustomerId: customerId ?? undefined,
                  stripeSubscriptionId: subscriptionId,
                  checkoutSessionId: session.id
                },
                update: {
                  subscriptionId: dbSub?.id ?? undefined,
                  stripeCustomerId: customerId ?? undefined,
                  endedAt: null
                }
              });
            }
          }
        }

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
          botStatus = "CANCELED";
        } else {
          botStatus = "SUSPENDED";
        }

        await prisma.bot.update({
          where: { id: dbSub.botId },
          data: { status: botStatus }
        });

        // ✅ End attribution when subscription is not active/trialing
        const isActive = isStripeSubActive(sub.status);
        if (!isActive) {
          await prisma.referralAttribution.updateMany({
            where: { stripeSubscriptionId },
            data: { endedAt: new Date() }
          });
        } else {
          await prisma.referralAttribution.updateMany({
            where: { stripeSubscriptionId },
            data: { endedAt: null }
          });
        }

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

        const billingEmail = invoice.customer_email ?? undefined;
        const billingName = invoice.customer_name ?? undefined;
        const billingAddress = invoice.customer_address ?? null;

        const firstLine = invoice.lines.data[0];
        const period = firstLine?.period;
        const periodStart = period?.start ? new Date(period.start * 1000) : null;
        const periodEnd = period?.end ? new Date(period.end * 1000) : null;

        const invoiceMetadata = invoice.metadata || {};

        // Identify bot via subscription record (normal subscription invoices)
        // or via explicit botId for one-off top-ups
        let botId: string | undefined;
        let subscriptionDbId: string | undefined;

        if (stripeSubscriptionId) {
          const dbSub = await prisma.subscription.findFirst({
            where: { stripeSubscriptionId }
          });
          botId = dbSub?.botId;
          subscriptionDbId = dbSub?.id;
        } else if (invoiceMetadata.botId) {
          botId = invoiceMetadata.botId as string;
        }

        if (!botId) {
          console.warn(
            "invoice.payment_succeeded without identifiable botId for invoice",
            stripeInvoiceId
          );
          break;
        }

        const kind =
          (invoiceMetadata.kind as string | undefined) === "TOP_UP"
            ? "TOP_UP"
            : "SUBSCRIPTION";

        const topupTokensRaw = invoiceMetadata.topupTokens as string | undefined;
        const topupTokens =
          kind === "TOP_UP" && topupTokensRaw
            ? parseInt(topupTokensRaw, 10) || 0
            : null;

        const payment = await prisma.payment.create({
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
            billingAddressJson: billingAddress ? (billingAddress as any) : undefined,
            periodStart: periodStart ?? undefined,
            periodEnd: periodEnd ?? undefined,
            kind,
            topupTokens: topupTokens ?? undefined
          }
        });

        // ✅ Referral commission ledger per paid invoice (subscription invoices only)
        if (stripeSubscriptionId) {
          const attribution = await prisma.referralAttribution.findUnique({
            where: { stripeSubscriptionId },
            include: { partner: true }
          });

          if (attribution && attribution.partner.status === "ACTIVE") {
            // Prefer subtotal (pre-tax). If not present, fall back to amount_paid.
            const base =
              typeof (invoice as any).subtotal === "number" &&
              (invoice as any).subtotal > 0
                ? (invoice as any).subtotal
                : amountCents;

            const commissionCents = computeCommissionCents(
              base,
              attribution.partner.commissionBps
            );

            const monthKey = monthKeyForDate(
              periodStart ?? new Date(invoice.created * 1000)
            );

            try {
              await prisma.$transaction([
                prisma.referralCommission.create({
                  data: {
                    partnerId: attribution.partnerId,
                    attributionId: attribution.id,
                    botId,
                    subscriptionId: subscriptionDbId,
                    paymentId: payment.id,
                    stripeSubscriptionId,
                    stripeInvoiceId,
                    kind: "EARNED",
                    status: "PENDING",
                    amountBaseCents: base,
                    commissionCents,
                    currency,
                    periodStart: periodStart ?? undefined,
                    periodEnd: periodEnd ?? undefined,
                    monthKey
                  }
                }),

                prisma.referralPayoutPeriod.upsert({
                  where: {
                    partnerId_month_currency: {
                      partnerId: attribution.partnerId,
                      monthKey,
                      currency
                    }
                  },
                  create: {
                    partnerId: attribution.partnerId,
                    monthKey,
                    currency,
                    amountCents: commissionCents,
                    status: "OPEN"
                  },
                  update: {
                    amountCents: { increment: commissionCents }
                  }
                })
              ]);
            } catch (e: any) {
              // Likely a webhook retry
              if (e?.code !== "P2002") {
                console.error("Failed to create referral commission", e);
              }
            }
          }
        }

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
          console.warn("invoice.payment_failed without identifiable botId", invoice.id);
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

        break;
      }

      // ✅ Optional but recommended: reversal when invoice is voided
      case "invoice.voided": {
        const invoice = event.data.object as Stripe.Invoice;
        const stripeInvoiceId = invoice.id;
        const stripeSubscriptionId = invoice.subscription as string | null;
        if (!stripeSubscriptionId) break;

        const earned = await prisma.referralCommission.findFirst({
          where: { stripeInvoiceId, kind: "EARNED" }
        });
        if (!earned) break;

        try {
          const reversalCommissionCents = -Math.abs(earned.commissionCents);
          const reversalBaseCents = -Math.abs(earned.amountBaseCents);

          await prisma.$transaction([
            prisma.referralCommission.create({
              data: {
                partnerId: earned.partnerId,
                attributionId: earned.attributionId ?? undefined,
                botId: earned.botId,
                subscriptionId: earned.subscriptionId ?? undefined,
                stripeSubscriptionId: earned.stripeSubscriptionId,
                stripeInvoiceId: earned.stripeInvoiceId,
                kind: "REVERSAL",
                status: "PENDING",
                amountBaseCents: reversalBaseCents,
                commissionCents: reversalCommissionCents,
                currency: earned.currency,
                periodStart: earned.periodStart ?? undefined,
                periodEnd: earned.periodEnd ?? undefined,
                monthKey: earned.monthKey
              }
            }),

            prisma.referralPayoutPeriod.upsert({
              where: {
                partnerId_month_currency: {
                  partnerId: earned.partnerId,
                  monthKey: earned.monthKey,
                  currency: earned.currency
                }
              },
              create: {
                partnerId: earned.partnerId,
                monthKey: earned.monthKey,
                currency: earned.currency,
                amountCents: reversalCommissionCents,
                status: "OPEN"
              },
              update: {
                amountCents: { increment: reversalCommissionCents }
              }
            })
          ]);
        } catch (e: any) {
          if (e?.code !== "P2002") {
            console.error("Failed to reverse referral commission", e);
          }
        }

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
