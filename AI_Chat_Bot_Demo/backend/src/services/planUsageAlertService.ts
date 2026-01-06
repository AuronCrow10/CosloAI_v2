// services/planUsageAlertService.ts

import { prisma } from "../prisma/prisma";
import { getPlanUsageForBot } from "./planUsageService";
import { sendMail } from "./mailer";
import { sendUsageAlertPushToUser } from "./pushNotificationService";

const USAGE_ALERT_THRESHOLDS = [50, 70, 90, 100] as const;
type UsageAlertThreshold = (typeof USAGE_ALERT_THRESHOLDS)[number];

function getCurrentBillingMonthUtc() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  return { year, month, monthStart };
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
  const { threshold, percent, botName, usedTokens, limitTokens } = params;

  const roundedPercent = Math.min(100, Math.round(percent));

  let subject: string;
  let intro: string;
  let bodyExtra: string;

  if (threshold === 50) {
    subject = `Heads up: ${botName} has used 50% of its monthly quota`;
    intro = `Quick heads up! Your assistant **${botName}** has already used about ${roundedPercent}% of the tokens included in this month’s plan.`;
    bodyExtra = `You’re on a healthy trajectory, but it’s a good moment to check that your configuration matches your expected traffic.`;
  } else if (threshold === 70) {
    subject = `${botName} is at 70% of its monthly plan`;
    intro = `Your assistant **${botName}** has now consumed around ${roundedPercent}% of this month’s available tokens.`;
    bodyExtra = `If you expect a spike in traffic or campaigns, you may want to monitor usage more closely or consider upgrading the plan.`;
  } else if (threshold === 90) {
    subject = `${botName} is close to its monthly limit (${roundedPercent}%)`;
    intro = `Your assistant **${botName}** is approaching the top of its monthly quota, currently around ${roundedPercent}% used.`;
    bodyExtra = `At this pace you may reach the limit soon, which could temporarily stop new conversations or background operations until the next billing month.`;
  } else {
    // 100%
    subject = `${botName} has reached 100% of its monthly usage`;
    intro = `Your assistant **${botName}** has reached 100% of the tokens included in this month’s plan.`;
    bodyExtra = `Further usage may be blocked or limited until the next billing month starts, depending on your configuration.`;
  }

  const statsLine = `Current usage: ${usedTokens.toLocaleString()} / ${limitTokens.toLocaleString()} tokens (${roundedPercent}%).`;

  const text = [
    intro.replace(/\*\*/g, ""), // strip markdown for plain text
    "",
    statsLine,
    "",
    bodyExtra,
    "",
    "You can review detailed usage and manage your plan from the dashboard.",
    "",
    "— Your AI Assistant"
  ].join("\n");

  const html = `
    <p>${intro}</p>
    <p><strong>${statsLine}</strong></p>
    <p>${bodyExtra}</p>
    <p>
      You can review detailed usage and manage your plan from the dashboard.
    </p>
    <p>— Your AI Assistant</p>
  `;

  return { subject, text, html };
}

/**
 * Check the current monthly usage for a bot, compare against thresholds
 * (50/70/90/100%), and send notifications to the owner if we cross any
 * thresholds that haven’t been notified yet this month.
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
    // Below the lowest threshold → nothing to do
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

  const { year, month } = getCurrentBillingMonthUtc();

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

  const alreadySent = new Set<number>(
    existingAlerts.map((a) => a.threshold)
  );

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
  // - record them in PlanUsageAlert so we don't resend this month
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
      console.error(
        "[PlanUsageAlert] Failed to send usage alert notification",
        {
          botId,
          threshold,
          error: err
        }
      );
      // Don't throw – we never want alerts to break main flows
    }
  }
}
