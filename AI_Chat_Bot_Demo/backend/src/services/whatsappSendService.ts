// src/services/whatsappSendService.ts
import axios from "axios";
import util from "node:util";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { normalizeAxiosError, isWhatsAppAuthError, markWhatsAppNeedsReconnect } from "../routes/whatsappWebhook"; // or extract these helpers out of whatsappWebhook.ts
import {
  ensureBotHasTokens,
  WHATSAPP_MESSAGE_TOKEN_COST,
  getCurrentUsageRangeForBot
} from "./planUsageService";
import { maybeSendUsageAlertsForBot } from "./planUsageAlertService";

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_WEIGHT: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

const LOG_LEVEL = ((process.env.LOG_LEVEL || "INFO").toUpperCase() as Level) || "INFO";

function ts() {
  return new Date().toISOString();
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (typeof v === "string") {
    const needsQuotes = /[\s"=|]/.test(v);
    return needsQuotes ? JSON.stringify(v) : v;
  }

  return util.inspect(v, { depth: 2, breakLength: 160, compact: true });
}

function fmtCtx(ctx: Record<string, unknown>) {
  const entries = Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, v] as const);

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${formatVal(v)}`).join(" ");
}

function logLine(level: Level, src: "WA" | "META", msg: string, ctx: Record<string, unknown> = {}) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[LOG_LEVEL]) return;

  const line =
    `${ts()} | ${level.padEnd(5)} | ${src.padEnd(4)} | ${msg.padEnd(28)} | ` +
    fmtCtx(ctx);

  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

function maskPhone(v: string | undefined) {
  if (!v) return "";
  const digits = v.replace(/\D/g, "");
  if (digits.length <= 4) return digits;
  return `***${digits.slice(-4)}`;
}

function extractWaMessageId(data: unknown): string | undefined {
  const d: any = data;
  return d?.messages?.[0]?.id || d?.message_id || d?.id;
}

function safeErrorData(data: unknown): unknown {
  if (typeof data === "string") return data.slice(0, 400);
  return data;
}

export async function sendLeadWhatsAppTemplate(
  requestId: string,
  botId: string,
  toPhone: string,
  templateName: string,
  languageCode: string,
  components?: any[]
) {

  // ---- WhatsApp lead soft cap (per bot / per month) ----
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: {
      subscription: {
        include: { usagePlan: true }
      }
    }
  });

  logLine("INFO", "WA", "lead template send start", {
    req: requestId,
    bot: botId,
    to: maskPhone(toPhone),
    template: templateName,
    lang: languageCode,
    components: components?.length ?? 0
  });

  const whatsappCap =
    bot?.subscription?.usagePlan?.monthlyWhatsappLeads ?? null;

  if (whatsappCap && whatsappCap > 0) {
    const { from, to } = await getCurrentUsageRangeForBot(botId);

    const leadsThisMonth = await prisma.metaLead.count({
      where: {
        botId,
        whatsappStatus: "SENT",
        createdAt: { gte: from, lt: to }
      }
    });

    if (leadsThisMonth >= whatsappCap) {
      const err: any = new Error("WhatsApp lead soft cap reached");
      err.code = "WHATSAPP_LEAD_SOFT_CAP_REACHED";
      err.usedThisPeriod = leadsThisMonth;
      err.limit = whatsappCap;
      logLine("WARN", "WA", "lead template send blocked", {
        req: requestId,
        bot: botId,
        reason: "SOFT_CAP_REACHED",
        used: leadsThisMonth,
        limit: whatsappCap
      });
      throw err;
    }
  }
  // Token quota check for lead WA messages
  const quota = await ensureBotHasTokens(botId, WHATSAPP_MESSAGE_TOKEN_COST);
  if (!quota.ok) {
    const err: any = new Error("WhatsApp lead message quota exceeded");
    err.code = "TOKEN_QUOTA_EXCEEDED";
    err.usedThisPeriod = quota.snapshot?.usedTokensTotal;
    err.limit = quota.snapshot?.monthlyTokenLimit;
    logLine("WARN", "WA", "lead template send blocked", {
      req: requestId,
      bot: botId,
      reason: "TOKEN_QUOTA_EXCEEDED",
      used: err.usedThisPeriod,
      limit: err.limit
    });
    throw err;
  }

  const channel = await prisma.botChannel.findFirst({
    where: { botId, type: "WHATSAPP" }
  });

  if (!channel) {
    logLine("ERROR", "WA", "lead template send failed", {
      req: requestId,
      bot: botId,
      reason: "CHANNEL_NOT_FOUND"
    });
    throw new Error("WhatsApp channel not found for bot");
  }

  if (!config.whatsappApiBaseUrl) {
    logLine("ERROR", "WA", "lead template send failed", {
      req: requestId,
      bot: botId,
      reason: "MISSING_API_BASE_URL"
    });
    throw new Error("whatsappApiBaseUrl not configured");
  }

  const phoneNumberId = channel.externalId;
  const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;

  const accessToken = channel.accessToken || config.whatsappAccessToken;
  if (!accessToken) {
    logLine("ERROR", "WA", "lead template send failed", {
      req: requestId,
      bot: botId,
      reason: "MISSING_ACCESS_TOKEN"
    });
    throw new Error("Missing WhatsApp access token");
  }

  const body: any = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode }
    }
  };

  if (components && components.length > 0) {
    body.template.components = components;
  }

  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    // We only get here on successful send → usage will increase via MetaLead.
    void maybeSendUsageAlertsForBot(botId);

    logLine("INFO", "WA", "lead template sent", {
      req: requestId,
      bot: botId,
      status: resp.status,
      messageId: extractWaMessageId(resp.data),
      phoneNumberId
    });

    return resp.data;
  } catch (err) {
    const n = normalizeAxiosError(err);
    // log error, then mark needsReconnect if auth issue
    logLine("ERROR", "WA", "lead template send failed", {
      req: requestId,
      bot: botId,
      status: n.status ?? "unknown",
      data: safeErrorData(n.data),
      phoneNumberId
    });
    if (isWhatsAppAuthError(err)) {
      await markWhatsAppNeedsReconnect(requestId, channel.id, "lead_template_send_auth_error");
    }
    throw new Error(
      `WhatsApp send failed (status=${n.status ?? "unknown"})`
    );
  }
}
