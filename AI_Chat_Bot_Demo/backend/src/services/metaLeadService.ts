// src/services/metaLeadService.ts
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import {
  refreshPageAccessTokenForChannel,
  isMetaTokenErrorNeedingRefresh
} from "../services/metaTokenService";
import { sendLeadWhatsAppTemplate } from "../services/whatsappSendService";


type LeadPayload = {
  field_data?: Array<{ name?: string; values?: string[] }>;
  ad_id?: string;
  campaign_id?: string;
  form_id?: string;
  created_time?: string;
  [key: string]: any;
};

function extractField(
  fields: LeadPayload["field_data"],
  fieldName: string | undefined
): string | undefined {
  if (!fields || !fieldName) return undefined;
  const f = fields.find((fd) => fd?.name === fieldName);
  if (!f?.values?.length) return undefined;
  return String(f.values[0]).trim();
}

function looksTrue(v: string | undefined) {
  if (!v) return false;
  const s = v.toLowerCase().trim();
  return ["yes", "true", "1", "ok", "agree", "y"].includes(s);
}


function getLeadWhatsappLimitForBot(bot: {
  leadWhatsappMessages200?: boolean | null;
  leadWhatsappMessages500?: boolean | null;
  leadWhatsappMessages1000?: boolean | null;
}): number | null {
  if (bot.leadWhatsappMessages1000) return 1000;
  if (bot.leadWhatsappMessages500) return 500;
  if (bot.leadWhatsappMessages200) return 200;
  return null;
}

/**
 * Called from metaWebhook when a leadgen event is received.
 */
export async function handleMetaLeadgen(
  requestId: string,
  pageId: string,
  leadgenId: string,
  formId?: string
) {
  const channel = await prisma.botChannel.findFirst({
    where: { type: "FACEBOOK", externalId: pageId },
    include: { bot: true }
  });

  if (!channel?.bot) {
    // Unknown page – just ignore to stay multi-tenant-safe.
    return;
  }

  const bot = channel.bot;
  if (bot.status !== "ACTIVE") return;


  // Enforce: feature must be purchased AND WhatsApp channel enabled
const limit = getLeadWhatsappLimitForBot(bot as any);

if (!bot.channelWhatsapp || !limit) {
  // Still store the lead, but do not send WA
  const leadPayload = await fetchLeadFromGraph(requestId, channel.id, leadgenId);
  await prisma.metaLead.create({
    data: {
      botId: bot.id,
      pageId,
      leadgenId,
      formId: leadPayload.form_id ?? formId,
      adId: leadPayload.ad_id ?? null,
      campaignId: (leadPayload as any).campaign_id ?? null,
      phone: null,
      whatsappOptIn: false,
      rawPayload: leadPayload,
      whatsappStatus: "SKIPPED",
      whatsappError: "LEAD_WHATSAPP_NOT_ENABLED"
    }
  });
  return;
}

  // Find automation config for this bot/page/form
  const automation = await prisma.metaLeadAutomation.findFirst({
    where: {
      botId: bot.id,
      pageId,
      enabled: true
    }
  });

  // Even if there is no automation, we'll still fetch + store the lead.
  const leadPayload = await fetchLeadFromGraph(requestId, channel.id, leadgenId);

  const fieldData = (leadPayload.field_data ?? []) as LeadPayload["field_data"];
  const phone = extractField(fieldData, automation?.phoneFieldName ?? "phone_number");
  const consentVal = extractField(fieldData, automation?.consentFieldName ?? "");
  const whatsappOptIn =
    automation?.requiresWhatsappOptIn === false ? true : looksTrue(consentVal);

  const created = await prisma.metaLead.create({
    data: {
      botId: bot.id,
      pageId,
      leadgenId,
      formId: leadPayload.form_id ?? formId,
      adId: leadPayload.ad_id ?? null,
      campaignId: (leadPayload as any).campaign_id ?? null,
      phone,
      whatsappOptIn,
      rawPayload: leadPayload,
      whatsappStatus: "PENDING"
    }
  });

  if (!automation) {
    // No configured automation -> do not send WhatsApp, but we have the lead stored.
    await prisma.metaLead.update({
      where: { id: created.id },
      data: { whatsappStatus: "SKIPPED", whatsappError: "NO_AUTOMATION_CONFIG" }
    });
    return;
  }

  if (!phone) {
    await prisma.metaLead.update({
      where: { id: created.id },
      data: { whatsappStatus: "SKIPPED", whatsappError: "MISSING_PHONE" }
    });
    return;
  }

  if (!whatsappOptIn) {
    await prisma.metaLead.update({
      where: { id: created.id },
      data: { whatsappStatus: "SKIPPED", whatsappError: "NO_WHATSAPP_OPT_IN" }
    });
    return;
  }


  // Monthly quota check
const now = new Date();
const from = new Date(now.getFullYear(), now.getMonth(), 1);
const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);

const sentThisMonth = await prisma.metaLead.count({
  where: {
    botId: bot.id,
    whatsappStatus: "SENT",
    createdAt: { gte: from, lt: to }
  }
});

if (sentThisMonth >= limit) {
  await prisma.metaLead.update({
    where: { id: created.id },
    data: {
      whatsappStatus: "SKIPPED",
      whatsappError: "LEAD_WHATSAPP_LIMIT_REACHED"
    }
  });
  return;
}

  // Try sending WhatsApp template
  try {
    await sendLeadWhatsAppTemplate(
      requestId,
      bot.id,
      phone,
      automation.whatsappTemplateName,
      automation.whatsappTemplateLanguage
    );

    await prisma.metaLead.update({
      where: { id: created.id },
      data: { whatsappStatus: "SENT", whatsappError: null }
    });
  } catch (err: any) {
    await prisma.metaLead.update({
      where: { id: created.id },
      data: {
        whatsappStatus: "FAILED",
        whatsappError: err?.message?.slice(0, 500) ?? "SEND_FAILED"
      }
    });
  }
}

async function fetchLeadFromGraph(
  requestId: string,
  channelId: string,
  leadgenId: string
): Promise<LeadPayload> {
  const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
  if (!channel || !config.metaGraphApiBaseUrl) {
    throw new Error("Meta config missing");
  }

  const baseUrl = config.metaGraphApiBaseUrl;
  const fields =
    "field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,created_time,form_id,custom_disclaimer_responses";

  let accessToken = channel.accessToken || config.metaPageAccessToken;
  if (!accessToken) {
    throw new Error("Missing page access token");
  }

  const url = `${baseUrl}/${leadgenId}`;

  const doGet = async (token: string) =>
    axios.get(url, {
      params: { access_token: token, fields },
      timeout: 10000
    });

  try {
    const resp = await doGet(accessToken);
    return resp.data as LeadPayload;
  } catch (err: any) {
    if (!isMetaTokenErrorNeedingRefresh(err)) {
      throw err;
    }

    const refreshed = await refreshPageAccessTokenForChannel(channelId);
    if (!refreshed?.accessToken) throw err;

    accessToken = refreshed.accessToken;
    const resp2 = await doGet(accessToken);
    return resp2.data as LeadPayload;
  }
}
