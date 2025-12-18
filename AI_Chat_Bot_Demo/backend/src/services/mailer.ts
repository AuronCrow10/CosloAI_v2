// services/mailer.ts

import nodemailer from "nodemailer";
import { config } from "../config";
import { prisma } from "../prisma/prisma";
import {
  EmailUsageKind,
  getEmailUsageForBot,
  recordEmailUsage
} from "./emailUsageService";

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

export type SendBotMailResult = {
  sent: boolean;
  reason?: "smtp_not_configured" | "quota_exceeded" | "error";
  error?: unknown;
  usedThisPeriod?: number;
  limit?: number | null;
};

/**
 * Bot-aware send function:
 *  - If botId is null/undefined → no quota, just send (still requires SMTP).
 *  - If botId exists → enforces UsagePlan.monthlyEmails per calendar month.
 */
export async function sendBotMail(params: {
  botId: string | null | undefined;
  kind: EmailUsageKind;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<SendBotMailResult> {
  const transport = getTransporter();
  if (!transport) {
    console.warn(
      "[Mailer] sendBotMail called but SMTP is not configured. Skipping.",
      { to: params.to, subject: params.subject }
    );
    return { sent: false, reason: "smtp_not_configured" };
  }

  // Bots without a DB record (e.g. static demo bots)
  // → send email without quotas, but still log a warning for clarity.
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

  try {
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
      console.error(
        "[Mailer] sendBotMail: Bot not found for botId",
        params.botId
      );
      // Fallback: send without quota so we don't silently lose important emails
      try {
        await sendMail({
          to: params.to,
          subject: params.subject,
          text: params.text,
          html: params.html
        });
        return { sent: true, limit: null };
      } catch (err) {
        console.error(
          "[Mailer] sendBotMail fallback (no bot) failed",
          err
        );
        return { sent: false, reason: "error", error: err };
      }
    }

    const usagePlan = bot.subscription?.usagePlan ?? null;
    const monthlyEmails = usagePlan?.monthlyEmails ?? null;

    // No plan or no email limit configured => treat as unlimited
    if (!monthlyEmails || monthlyEmails <= 0) {
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

    // Calendar-month window (same as billing overview)
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const emailUsage = await getEmailUsageForBot({
      botId: params.botId,
      from,
      to
    });

    if (emailUsage.count >= monthlyEmails) {
      console.warn("[Mailer] Email quota exceeded for bot", {
        botId: params.botId,
        used: emailUsage.count,
        limit: monthlyEmails
      });
      return {
        sent: false,
        reason: "quota_exceeded",
        usedThisPeriod: emailUsage.count,
        limit: monthlyEmails
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

    return {
      sent: true,
      usedThisPeriod: emailUsage.count + 1,
      limit: monthlyEmails
    };
  } catch (err) {
    console.error("[Mailer] sendBotMail failed", err);
    return { sent: false, reason: "error", error: err };
  }
}
