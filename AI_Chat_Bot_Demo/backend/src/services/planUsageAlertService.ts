// services/planUsageAlertService.ts

import { prisma } from "../prisma/prisma";
import { getPlanUsageForBot } from "./planUsageService";
import { sendMail } from "./mailer";
import { sendUsageAlertPushToUser } from "./pushNotificationService";
import {
  buildPlanUsageAlertEmail,
  getFrontendOrigin
} from "./systemEmailTemplates";

const USAGE_ALERT_THRESHOLDS = [50, 70, 90, 100] as const;
type UsageAlertThreshold = (typeof USAGE_ALERT_THRESHOLDS)[number];

function getUsageWindowKey(periodStart: Date) {
  return {
    year: periodStart.getUTCFullYear(),
    month: periodStart.getUTCMonth() + 1
  };
}

type UsageAlertEmailContent = {
  subject: string;
  text: string;
  html?: string;
};

function buildUsageAlertEmailContent(params: {
  threshold: UsageAlertThreshold;
  percent: number;
  botName: string;
  usedTokens: number;
  limitTokens: number;
}): UsageAlertEmailContent {
  const dashboardUrl = `${getFrontendOrigin()}/app/dashboard`;
  const rendered = buildPlanUsageAlertEmail({
    threshold: params.threshold,
    percent: params.percent,
    botName: params.botName,
    usedTokens: params.usedTokens,
    limitTokens: params.limitTokens,
    dashboardUrl
  });

  return {
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html
  };
}

/**
 * Check the current monthly usage for a bot, compare against thresholds
 * (50/70/90/100%), and send notifications to the owner if we cross any
 * thresholds that have not been notified yet this month.
 *
 * IMPORTANT:
 * - Emails use `sendMail` directly so they are NOT counted in plan usage / EmailUsage.
 * - Mobile pushes go through `sendUsageAlertPushToUser` and also do not affect usage.
 */
export async function maybeSendUsageAlertsForBot(
  botId: string
): Promise<void> {
  // Get plan snapshot (includes monthlyTokenLimit and usedTokensTotal)
  const snapshot = await getPlanUsageForBot(botId);
  if (!snapshot) return;

  const { monthlyTokenLimit, usedTokensTotal } = snapshot;

  // No limit = nothing to alert on
  if (!monthlyTokenLimit || monthlyTokenLimit <= 0) return;

  const percent = (usedTokensTotal / monthlyTokenLimit) * 100;
  if (percent < USAGE_ALERT_THRESHOLDS[0]) {
    // Below the lowest threshold -> nothing to do
    return;
  }

  // Load bot + owner email/user
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: { user: true }
  });

  if (!bot || !bot.user || !bot.user.email) {
    return;
  }

  const ownerEmail = bot.user.email;
  const ownerId = bot.user.id;
  const botName = bot.name || "your assistant";

  const { year, month } = getUsageWindowKey(snapshot.periodStart);

  // Find which alerts we already sent for this bot/month
  const existingAlerts = await prisma.planUsageAlert.findMany({
    where: {
      botId,
      year,
      month
    },
    select: {
      threshold: true
    }
  });

  const alreadySent = new Set<number>(existingAlerts.map((a) => a.threshold));
  const alertsToCreate: UsageAlertThreshold[] = [];

  for (const threshold of USAGE_ALERT_THRESHOLDS) {
    if (percent >= threshold && !alreadySent.has(threshold)) {
      alertsToCreate.push(threshold);
    }
  }

  if (alertsToCreate.length === 0) {
    return;
  }

  // We deliberately:
  // - send one email + one push per threshold
  // - record them in PlanUsageAlert so we do not resend this month
  for (const threshold of alertsToCreate) {
    const { subject, text, html } = buildUsageAlertEmailContent({
      threshold,
      percent,
      botName,
      usedTokens: usedTokensTotal,
      limitTokens: monthlyTokenLimit
    });

    try {
      // 1) Send email alert (NOT counted as plan usage)
      await sendMail({
        to: ownerEmail,
        subject,
        text,
        html
      });

      // 2) Send mobile push alert (fire-and-forget)
      if (ownerId) {
        void sendUsageAlertPushToUser(ownerId, {
          botId,
          botName,
          threshold,
          percent,
          usedTokens: usedTokensTotal,
          limitTokens: monthlyTokenLimit
        });
      }

      // 3) Record that we sent this threshold this month
      await prisma.planUsageAlert.create({
        data: {
          botId,
          year,
          month,
          threshold
        }
      });
    } catch (err) {
      console.error("[PlanUsageAlert] Failed to send usage alert notification", {
        botId,
        threshold,
        error: err
      });
      // Do not throw - we never want alerts to break main flows.
    }
  }
}
