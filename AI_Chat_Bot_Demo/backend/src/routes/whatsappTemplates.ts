// src/routes/whatsappTemplates.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import crypto from "crypto";
import util from "node:util";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";

const router = Router();

/**
 * Minimal logger copied from whatsappWebhook.ts to keep logs consistent.
 */
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

function getRequestId(req: Request) {
  const existing =
    (req.headers["x-request-id"] as string | undefined) ||
    (req.headers["x-correlation-id"] as string | undefined);
  return existing || crypto.randomUUID();
}

function normalizeAxiosError(err: unknown) {
  if (!axios.isAxiosError(err)) return { status: undefined, data: err };
  return { status: err.response?.status, data: err.response?.data ?? err.message };
}

function isWhatsAppAuthError(err: unknown): boolean {
  const ax = axios.isAxiosError(err) ? err : undefined;
  const status = ax?.response?.status;
  const code = (ax?.response?.data as any)?.error?.code;
  return status === 401 || status === 403 || code === 190;
}

async function markWhatsAppNeedsReconnect(requestId: string, channelId: string, context: string) {
  try {
    const channel = await prisma.botChannel.findUnique({ where: { id: channelId } });
    const currentMeta = (channel?.meta as any) || {};

    await prisma.botChannel.update({
      where: { id: channelId },
      data: {
        meta: { ...currentMeta, needsReconnect: true }
      }
    });

    logLine("WARN", "WA", "marked needsReconnect", {
      req: requestId,
      channel: channelId,
      ctx: context
    });
  } catch (e: unknown) {
    logLine("ERROR", "WA", "mark needsReconnect failed", {
      req: requestId,
      channel: channelId
    });
    logLine("DEBUG", "WA", "mark needsReconnect failed details", {
      req: requestId,
      details: e
    });
  }
}

/**
 * Local HttpError helper so we can throw + catch with a status code.
 */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Zod schemas for incoming payloads.
 * We keep them intentionally close to WhatsApp's template structure.
 */

const buttonSchema = z.object({
  type: z.enum(["QUICK_REPLY", "URL", "PHONE_NUMBER"]),
  text: z.string().min(1),
  url: z.string().url().optional(),
  phone_number: z.string().optional()
});

const componentSchema = z.object({
  type: z.enum(["HEADER", "BODY", "FOOTER", "BUTTONS"]),
  format: z.enum(["TEXT"]).optional(),
  text: z.string().optional(),
  example: z
    .object({
      body_text: z.array(z.string()).optional(),
      header_text: z.array(z.string()).optional()
    })
    .optional(),
  buttons: z.array(buttonSchema).optional()
});

const templateUpsertSchema = z.object({
  name: z
    .string()
    .min(3)
    // WhatsApp requires lowercase + underscores; we enforce basic sanity here.
    .regex(/^[a-z0-9_]+$/, "Use lowercase letters, numbers and underscores only."),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]),
  language: z.string().min(2), // e.g. "en_US"
  components: z.array(componentSchema).min(1)
});

const listQuerySchema = z.object({
  search: z.string().optional(),
  status: z
    .enum(["APPROVED", "REJECTED", "PENDING", "INACTIVE", "PAUSED"])
    .optional(),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]).optional(),
  language: z.string().optional(),
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
});

/**
 * Resolve WhatsApp context (bot, channel, WABA + token) for the current user.
 * - Ensures the bot belongs to the user.
 * - Requires an active WhatsApp channel (no needsReconnect).
 * - Uses the latest WhatsappConnectSession for that bot/user for WABA + token.
 */

/*
async function getWhatsAppContext(botId: string, userId: string) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId }
  });

  if (!bot) {
    throw new HttpError(404, "Bot not found");
  }

  const channel = await prisma.botChannel.findFirst({
    where: { botId: bot.id, type: "WHATSAPP" }
  });

  if (!channel) {
    throw new HttpError(400, "WhatsApp is not connected for this bot.");
  }

  const meta = (channel.meta as any) || {};
  if (meta.needsReconnect === true) {
    throw new HttpError(409, "WhatsApp connection needs to be refreshed.");
  }

  const lastSession = await prisma.whatsappConnectSession.findFirst({
    where: { botId: bot.id, userId },
    orderBy: { createdAt: "desc" }
  });

  if (!lastSession) {
    throw new HttpError(500, "WhatsApp credentials not found for this bot.");
  }

  if (!config.whatsappApiBaseUrl) {
    throw new HttpError(500, "WhatsApp API base URL is not configured.");
  }

  return {
    bot,
    channel,
    wabaId: lastSession.wabaId,
    accessToken: lastSession.waAccessToken
  };
}

*/

async function getWhatsAppContext(botId: string, userId: string) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId }
  });

  if (!bot) {
    throw new HttpError(404, "Bot not found");
  }

  const channel = await prisma.botChannel.findFirst({
    where: { botId: bot.id, type: "WHATSAPP" }
  });

  if (!channel) {
    throw new HttpError(400, "WhatsApp is not connected for this bot.");
  }

  const meta = (channel.meta as any) || {};
  if (meta.needsReconnect === true) {
    throw new HttpError(409, "WhatsApp connection needs to be refreshed.");
  }

  if (!config.whatsappApiBaseUrl) {
    throw new HttpError(500, "WhatsApp API base URL is not configured.");
  }

  // 1) Preferred path: embedded signup session
  //    (the long-term, “real” integration you care about)
  const lastSession = await prisma.whatsappConnectSession.findFirst({
    where: { botId: bot.id, userId },
    orderBy: { createdAt: "desc" }
  });

  if (lastSession) {
    return {
      bot,
      channel,
      wabaId: lastSession.wabaId,
      accessToken: lastSession.waAccessToken
    };
  }

  // 2) Temporary fallback: manual channel config
  //    Easy to remove later – just delete this block once you drop manual setup.
  const manualWabaId =
    typeof meta.wabaId === "string" && meta.wabaId.trim().length > 0
      ? meta.wabaId.trim()
      : undefined;

  const manualAccessToken =
    channel.accessToken || config.whatsappAccessToken;

  if (!manualWabaId || !manualAccessToken) {
    throw new HttpError(
      500,
      "WhatsApp credentials not found. For manual channels, set meta.wabaId and an accessToken on the channel."
    );
  }

  return {
    bot,
    channel,
    wabaId: manualWabaId,
    accessToken: manualAccessToken
  };
}




// All routes here require auth and live under /api
router.use("/bots/", requireAuth);

/**
 * GET /bots/:botId/whatsapp/templates
 * List templates for this bot's WABA, optionally filtered.
 */
router.get(
  "/bots/:botId/whatsapp/templates",
  async (req: Request, res: Response) => {
    const requestId = getRequestId(req);

    try {
      const { bot, channel, wabaId, accessToken } = await getWhatsAppContext(
        req.params.botId,
        req.user!.id
      );

      const parsedQuery = listQuerySchema.parse(req.query);

      const params: Record<string, unknown> = {};
      if (parsedQuery.limit && !Number.isNaN(parsedQuery.limit)) {
        params.limit = parsedQuery.limit;
      }
      if (parsedQuery.status) params.status = parsedQuery.status;
      if (parsedQuery.category) params.category = parsedQuery.category;
      if (parsedQuery.language) params.language = parsedQuery.language;
      if (parsedQuery.search) params.name = parsedQuery.search;
      if (parsedQuery.cursor) params.after = parsedQuery.cursor;

      const url = `${config.whatsappApiBaseUrl}/${encodeURIComponent(
        wabaId
      )}/message_templates`;

      const resp = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params,
        timeout: 10000
      });

      const data = resp.data as any;

      const items =
        Array.isArray(data?.data) ?
          data.data.map((tpl: any) => ({
            id: String(tpl.id),
            name: String(tpl.name),
            category: String(tpl.category ?? ""),
            language: String(tpl.language ?? ""),
            status: String(tpl.status ?? "PENDING"),
            components: Array.isArray(tpl.components) ? tpl.components : [],
            rejectionReason: (tpl as any).rejection_reason ?? null,
            qualityScore: (tpl as any).quality_score ?? null,
            lastUpdatedAt: (tpl as any).last_updated_time ?? null
          })) :
          [];

      const paging = data?.paging?.cursors
        ? {
            nextCursor: data.paging.cursors.after ?? null,
            previousCursor: data.paging.cursors.before ?? null
          }
        : null;

      logLine("INFO", "WA", "templates list", {
        req: requestId,
        bot: bot.slug,
        count: items.length
      });

      return res.json({ items, paging });
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        logLine("WARN", "WA", "templates list error", {
          req: requestId,
          status: err.status,
          msg: err.message
        });
        return res.status(err.status).json({ error: err.message });
      }

      const n = normalizeAxiosError(err);

      logLine("ERROR", "WA", "templates list WA error", {
        req: requestId,
        status: n.status
      });
      logLine("DEBUG", "WA", "templates list WA error details", {
        req: requestId,
        details: n.data
      });

      // If auth error -> mark needsReconnect
      try {
        if (isWhatsAppAuthError(err)) {
          const botId = req.params.botId;
          const channel = await prisma.botChannel.findFirst({
            where: { botId, type: "WHATSAPP" }
          });
          if (channel) {
            await markWhatsAppNeedsReconnect(
              requestId,
              channel.id,
              "templates_list_auth_error"
            );
          }
        }
      } catch (e) {
        // best effort only
      }

      return res
        .status(502)
        .json({ error: "WhatsApp API error while listing templates" });
    }
  }
);

/**
 * POST /bots/:botId/whatsapp/templates
 * Create a new template via Graph API.
 */
router.post(
  "/bots/:botId/whatsapp/templates",
  async (req: Request, res: Response) => {
    const requestId = getRequestId(req);

    try {
      const { bot, channel, wabaId, accessToken } = await getWhatsAppContext(
        req.params.botId,
        req.user!.id
      );

      const payload = templateUpsertSchema.parse(req.body);

      const url = `${config.whatsappApiBaseUrl}/${encodeURIComponent(
        wabaId
      )}/message_templates`;

      await axios.post(
        url,
        {
          name: payload.name,
          category: payload.category,
          language: payload.language,
          components: payload.components
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      );

      logLine("INFO", "WA", "template created", {
        req: requestId,
        bot: bot.slug,
        channel: channel.id,
        name: payload.name
      });

      // We just acknowledge and let the frontend re-fetch the list.
      return res.status(201).json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }

      const n = normalizeAxiosError(err);

      logLine("ERROR", "WA", "template create WA error", {
        req: requestId,
        status: n.status
      });
      logLine("DEBUG", "WA", "template create WA error details", {
        req: requestId,
        details: n.data
      });

      try {
        if (isWhatsAppAuthError(err)) {
          const botId = req.params.botId;
          const channel = await prisma.botChannel.findFirst({
            where: { botId, type: "WHATSAPP" }
          });
          if (channel) {
            await markWhatsAppNeedsReconnect(
              requestId,
              channel.id,
              "template_create_auth_error"
            );
          }
        }
      } catch {
        // ignore
      }

      return res
        .status(502)
        .json({ error: "WhatsApp API error while creating template" });
    }
  }
);

/**
 * PUT /bots/:botId/whatsapp/templates/:templateId
 * Edit an existing template using the upsert_message_templates edge.
 */
router.put(
  "/bots/:botId/whatsapp/templates/:templateId",
  async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { templateId } = req.params;

    try {
      const { bot, channel, wabaId, accessToken } = await getWhatsAppContext(
        req.params.botId,
        req.user!.id
      );

      const payload = templateUpsertSchema.parse(req.body);

      const url = `${config.whatsappApiBaseUrl}/${encodeURIComponent(
        wabaId
      )}/upsert_message_templates`;

      await axios.post(
        url,
        {
          message_templates: [
            {
              id: templateId,
              name: payload.name,
              category: payload.category,
              language: payload.language,
              components: payload.components
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      );

      logLine("INFO", "WA", "template updated", {
        req: requestId,
        bot: bot.slug,
        channel: channel.id,
        templateId
      });

      // Let the frontend re-fetch the updated list.
      return res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }

      const n = normalizeAxiosError(err);

      logLine("ERROR", "WA", "template update WA error", {
        req: requestId,
        status: n.status
      });
      logLine("DEBUG", "WA", "template update WA error details", {
        req: requestId,
        details: n.data
      });

      try {
        if (isWhatsAppAuthError(err)) {
          const botId = req.params.botId;
          const channel = await prisma.botChannel.findFirst({
            where: { botId, type: "WHATSAPP" }
          });
          if (channel) {
            await markWhatsAppNeedsReconnect(
              requestId,
              channel.id,
              "template_update_auth_error"
            );
          }
        }
      } catch {
        // ignore
      }

      return res
        .status(502)
        .json({ error: "WhatsApp API error while updating template" });
    }
  }
);

export default router;
