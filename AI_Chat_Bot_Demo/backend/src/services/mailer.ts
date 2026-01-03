// services/mailer.ts

import nodemailer from "nodemailer";
import { config } from "../config";
import { prisma } from "../prisma/prisma";
import {
  EmailUsageKind,
  getEmailUsageForBot,
  recordEmailUsage
} from "./emailUsageService";
import {
  ensureBotHasTokens,
  EMAIL_TOKEN_COST
} from "./planUsageService";

let transporter: nodemailer.Transporter | null = null;
let smtpConfigChecked = false;

function createTransporter(): nodemailer.Transporter | null {
  if (!config.smtpHost || !config.smtpPort || !config.smtpFrom) {
    if (!smtpConfigChecked) {
      console.warn(
        "[Mailer] SMTP is not fully configured. " +
          "Emails will NOT be sent until SMTP_HOST, SMTP_PORT and SMTP_FROM are set."
      );
      smtpConfigChecked = true;
    }
    return null;
  }

  const secure = config.smtpPort === 465;

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure,
    auth:
      config.smtpUser && config.smtpPassword
        ? {
            user: config.smtpUser,
            pass: config.smtpPassword
          }
        : undefined
  });

  smtpConfigChecked = true;
  return transport;
}

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  transporter = createTransporter();
  return transporter;
}

export type SendMailOptions = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

/**
 * Low-level send function, for emails where quotas don't matter
 * (or when called from sendBotMail internally).
 */
export async function sendMail(options: SendMailOptions): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    console.warn(
      "[Mailer] Skipping email send because SMTP is not configured.",
      {
        to: options.to,
        subject: options.subject
      }
    );
    return;
  }

  try {
    await transport.sendMail({
      from: config.smtpFrom!,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html
    });
  } catch (err) {
    console.error("[Mailer] Error sending email", {
      to: options.to,
      subject: options.subject,
      error: err
    });
    throw err;
  }
}

// --- Bot-aware sending with quotas ---

export type SendBotMailResult =
  | {
      sent: true;
      usedThisPeriod?: number;
      limit?: number | null;
    }
  | {
      sent: false;
      reason:
        | "quota_exceeded"
        | "smtp_not_configured"
        | "bot_not_found"
        | "error";
      usedThisPeriod?: number;
      limit?: number | null;
      error?: unknown;
    };

export async function sendBotMail(params: {
  botId: string | null | undefined;
  kind: EmailUsageKind;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<SendBotMailResult> {
  try {
    const transport = getTransporter();
    if (!transport) {
      console.warn(
        "[Mailer] Skipping email send because SMTP is not configured."
      );
      return { sent: false, reason: "smtp_not_configured" };
    }

    if (!params.botId) {
    try {
      await sendMail({
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html
      });
      return { sent: true, limit: null };
    } catch (err) {
      console.error("[Mailer] sendBotMail (no botId) failed", err);
      return { sent: false, reason: "error", error: err };
    }
  }

    const bot = await prisma.bot.findUnique({
      where: { id: params.botId },
      include: {
        subscription: {
          include: {
            usagePlan: true
          }
        }
      }
    });

    if (!bot) {
      console.warn("[Mailer] Bot not found for sendBotMail", {
        botId: params.botId
      });
      return { sent: false, reason: "bot_not_found" };
    }

    const monthlyTokens = bot.subscription?.usagePlan?.monthlyTokens ?? null;

    // If no monthly token limit → no quota check
    if (!monthlyTokens || monthlyTokens <= 0) {
      await sendMail({
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html
      });

      await recordEmailUsage({
        botId: params.botId,
        kind: params.kind,
        to: params.to
      });

      return { sent: true, limit: null };
    }

    // Token-based quota check (emails "cost" EMAIL_TOKEN_COST tokens)
    const quota = await ensureBotHasTokens(params.botId, EMAIL_TOKEN_COST);

    if (!quota.ok) {
      const used = quota.snapshot?.usedTokensTotal ?? 0;
      const limit = quota.snapshot?.monthlyTokenLimit ?? monthlyTokens;

      console.warn("[Mailer] Token quota exceeded for bot (email)", {
        botId: params.botId,
        used,
        limit
      });

      return {
        sent: false,
        reason: "quota_exceeded",
        usedThisPeriod: used,
        limit
      };
    }

    await sendMail({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html
    });

    await recordEmailUsage({
      botId: params.botId,
      kind: params.kind,
      to: params.to
    });

    const usedAfter =
      (quota.snapshot?.usedTokensTotal ?? 0) + EMAIL_TOKEN_COST;

    return {
      sent: true,
      usedThisPeriod: usedAfter,
      limit: quota.snapshot?.monthlyTokenLimit ?? monthlyTokens
    };
  } catch (err) {
    console.error("[Mailer] sendBotMail failed", err);
    return { sent: false, reason: "error", error: err };
  }
}
