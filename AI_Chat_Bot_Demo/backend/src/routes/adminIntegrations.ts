// src/routes/adminIntegrations.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const listQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => Number(v))
    .optional()
});

function extractPageNames(pagesJson: unknown): string[] {
  if (!Array.isArray(pagesJson)) return [];
  const names: string[] = [];
  for (const raw of pagesJson) {
    if (!raw || typeof raw !== "object") continue;
    const anyRaw = raw as any;
    const name = anyRaw.name || anyRaw.pageName || anyRaw.id;
    if (typeof name === "string" && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

function extractPhoneDisplay(phoneNumbersJson: unknown): string[] {
  if (!Array.isArray(phoneNumbersJson)) return [];
  const out: string[] = [];
  for (const raw of phoneNumbersJson) {
    if (!raw || typeof raw !== "object") continue;
    const anyRaw = raw as any;
    const value =
      anyRaw.display_phone_number ||
      anyRaw.phone_number ||
      anyRaw.phone ||
      anyRaw.wa_id ||
      anyRaw.id;

    if (typeof value === "string" && value.trim()) {
      out.push(value.trim());
    }
  }
  return out;
}

/**
 * GET /api/admin/integrations
 *
 * List Meta + WhatsApp integration sessions.
 * Query params:
 *  - q?: string (search by user email, bot name/slug, wabaId, channelType)
 *  - limit?: number (max rows per type, default 200, max 500)
 */
router.get(
  "/admin/integrations",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { q, limit } = parsed.data;
    const take = !limit || limit <= 0 || limit > 500 ? 200 : limit;
    const trimmedQ = q?.trim();
    const hasQuery = !!trimmedQ;

    const metaWhere: any = {};
    const whatsappWhere: any = {};

    if (hasQuery && trimmedQ) {
      const qIns = trimmedQ;
      metaWhere.OR = [
        { user: { email: { contains: qIns, mode: "insensitive" } } },
        { bot: { name: { contains: qIns, mode: "insensitive" } } },
        { bot: { slug: { contains: qIns, mode: "insensitive" } } },
        { channelType: { equals: trimmedQ.toUpperCase() } }
      ];

      whatsappWhere.OR = [
        { user: { email: { contains: qIns, mode: "insensitive" } } },
        { bot: { name: { contains: qIns, mode: "insensitive" } } },
        { bot: { slug: { contains: qIns, mode: "insensitive" } } },
        { wabaId: { contains: qIns, mode: "insensitive" } }
      ];
    }

    const [metaSessions, whatsappSessions] = await Promise.all([
      prisma.metaConnectSession.findMany({
        where: metaWhere,
        include: {
          user: true,
          bot: true
        },
        orderBy: { createdAt: "desc" },
        take
      }),
      prisma.whatsappConnectSession.findMany({
        where: whatsappWhere,
        include: {
          user: true,
          bot: true
        },
        orderBy: { createdAt: "desc" },
        take
      })
    ]);

    const meta = metaSessions.map((s) => {
      const pageNames = extractPageNames(s.pagesJson);
      return {
        id: s.id,
        createdAt: s.createdAt,
        channelType: s.channelType,
        user: {
          id: s.user.id,
          email: s.user.email
        },
        bot: {
          id: s.bot.id,
          name: s.bot.name,
          slug: s.bot.slug,
          status: s.bot.status
        },
        pages: {
          count: pageNames.length,
          names: pageNames.slice(0, 5)
        }
      };
    });

    const whatsapp = whatsappSessions.map((s) => {
      const phones = extractPhoneDisplay(s.phoneNumbersJson);
      return {
        id: s.id,
        createdAt: s.createdAt,
        wabaId: s.wabaId,
        user: {
          id: s.user.id,
          email: s.user.email
        },
        bot: {
          id: s.bot.id,
          name: s.bot.name,
          slug: s.bot.slug,
          status: s.bot.status
        },
        phoneNumbers: {
          count: phones.length,
          display: phones.slice(0, 5)
        }
      };
    });

    return res.json({ meta, whatsapp });
  }
);

const idParamSchema = z.object({
  id: z.string().min(1)
});

/**
 * DELETE /api/admin/integrations/meta/:id
 *
 * Hard-delete a MetaConnectSession and remove matching BotChannel
 * entries for the same bot + channelType.
 */
router.delete(
  "/admin/integrations/meta/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const { id } = parsed.data;

    const session = await prisma.metaConnectSession.findUnique({
      where: { id },
      include: { bot: true }
    });

    if (!session) {
      return res.status(404).json({ error: "Meta session not found" });
    }

    // Delete session + any associated BotChannel of that type
    await prisma.$transaction(async (tx) => {
      await tx.metaConnectSession.delete({ where: { id } });

      await tx.botChannel.deleteMany({
        where: {
          botId: session.botId,
          type: session.channelType
        }
      });
    });

    return res.json({ ok: true });
  }
);

/**
 * DELETE /api/admin/integrations/whatsapp/:id
 *
 * Hard-delete a WhatsappConnectSession and remove matching BotChannel
 * entries for the same bot + WHATSAPP type.
 */
router.delete(
  "/admin/integrations/whatsapp/:id",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const { id } = parsed.data;

    const session = await prisma.whatsappConnectSession.findUnique({
      where: { id },
      include: { bot: true }
    });

    if (!session) {
      return res.status(404).json({ error: "WhatsApp session not found" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.whatsappConnectSession.delete({ where: { id } });

      await tx.botChannel.deleteMany({
        where: {
          botId: session.botId,
          type: "WHATSAPP"
        }
      });
    });

    return res.json({ ok: true });
  }
);

export default router;
