import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import { sendMail } from "../services/mailer";
import {
  normalizeTeamPagesForKnowledgeSource,
  TEAM_PAGE_VALUES,
  TeamPagePermission
} from "../services/teamAccessService";

const router = Router();

router.use("/team", requireAuth);

const teamBotAccessSchema = z.object({
  botId: z.string().uuid(),
  pages: z.array(z.enum(TEAM_PAGE_VALUES)).optional()
});

const inviteSchema = z.object({
  email: z.string().email(),
  botIds: z.array(z.string().uuid()).min(1).optional(),
  botAccess: z.array(teamBotAccessSchema).min(1).optional()
}).refine((value) => (value.botIds && value.botIds.length > 0) || (value.botAccess && value.botAccess.length > 0), {
  message: "botIds or botAccess is required"
});

const memberBotsSchema = z.object({
  botIds: z.array(z.string().uuid()).min(1).optional(),
  botAccess: z.array(teamBotAccessSchema).min(1).optional()
}).refine((value) => (value.botIds && value.botIds.length > 0) || (value.botAccess && value.botAccess.length > 0), {
  message: "botIds or botAccess is required"
});

function mergeRequestedBotAccess(
  value: { botIds?: string[]; botAccess?: Array<{ botId: string; pages?: TeamPagePermission[] }> }
): Map<string, TeamPagePermission[]> {
  const map = new Map<string, TeamPagePermission[]>();
  for (const botId of value.botIds || []) {
    if (!map.has(botId)) {
      map.set(botId, []);
    }
  }
  for (const item of value.botAccess || []) {
    const existing = map.get(item.botId) || [];
    map.set(item.botId, Array.from(new Set([...existing, ...(item.pages || [])])));
  }
  return map;
}

router.post("/team/invites", async (req: Request, res: Response) => {
  if (!req.user || req.user.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const email = parsed.data.email.toLowerCase().trim();
  const requestedAccess = mergeRequestedBotAccess(parsed.data);
  const botIds = Array.from(requestedAccess.keys());

  const ownedBots = await prisma.bot.findMany({
    where: { id: { in: botIds }, userId: req.user.id },
    select: { id: true, name: true, knowledgeSource: true }
  });

  if (ownedBots.length !== botIds.length) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const normalizedBotAccess: Array<{
    botId: string;
    pages: TeamPagePermission[];
  }> = ownedBots.map((bot) => ({
    botId: bot.id,
    pages: normalizeTeamPagesForKnowledgeSource(
      requestedAccess.get(bot.id) || [],
      bot.knowledgeSource === "SHOPIFY" ? "SHOPIFY" : "RAG"
    )
  }));

  const token = randomBytes(32).toString("hex");

  const invite = await prisma.teamInvite.create({
    data: {
      email,
      token,
      invitedById: req.user.id,
      bots: {
        create: normalizedBotAccess.map(({ botId, pages }) => ({
          botId,
          pagePermissions: pages
        })) as any
      }
    },
    include: {
      bots: { include: { bot: true } }
    }
  });

  const frontendOrigin = process.env.FRONTEND_ORIGIN || "";
  const inviteUrl =
    frontendOrigin.trim()
      ? `${frontendOrigin.replace(/\/$/, "")}/register?invite=${encodeURIComponent(token)}`
      : `/register?invite=${encodeURIComponent(token)}`;

  const botNames = ownedBots.map((b) => b.name).join(", ");
  const subject = "You have been invited to join a Coslo workspace";
  const text = `You have been invited to access bots: ${botNames}.\n\nRegister here: ${inviteUrl}\n\nThis invite can be used once.`;

  await sendMail({
    to: email,
    subject,
    text
  });

  return res.status(201).json({
    id: invite.id,
    email: invite.email,
    createdAt: invite.createdAt,
    bots: invite.bots.map((b: any) => ({
      id: b.botId,
      name: b.bot.name,
      pages: Array.isArray(b.pagePermissions) ? b.pagePermissions : ["BOT_DETAIL"]
    }))
  });
});

router.get("/team/members", async (req: Request, res: Response) => {
  if (!req.user || req.user.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [memberships, invites] = await Promise.all([
    prisma.teamMembership.findMany({
      where: { bot: { userId: req.user.id } },
      include: {
        user: true,
        bot: true
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.teamInvite.findMany({
      where: { invitedById: req.user.id, usedAt: null, revokedAt: null },
      include: {
        bots: { include: { bot: true } }
      },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const memberMap = new Map<
    string,
    {
      userId: string;
      email: string;
      name: string | null;
      lastLoginAt: Date | null;
      createdAt: Date;
      bots: { id: string; name: string; pages: TeamPagePermission[] }[];
    }
  >();

  for (const m of memberships) {
    const existing = memberMap.get(m.userId);
    if (existing) {
      existing.bots.push({
        id: m.botId,
        name: m.bot.name,
        pages: Array.isArray((m as any).pagePermissions)
          ? (m as any).pagePermissions
          : ["BOT_DETAIL"]
      });
    } else {
      memberMap.set(m.userId, {
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        lastLoginAt: m.user.lastLoginAt,
        createdAt: m.user.createdAt,
        bots: [{
          id: m.botId,
          name: m.bot.name,
          pages: Array.isArray((m as any).pagePermissions)
            ? (m as any).pagePermissions
            : ["BOT_DETAIL"]
        }]
      });
    }
  }

  const members = Array.from(memberMap.values());

  return res.json({
    members,
    invites: invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      createdAt: invite.createdAt,
      bots: invite.bots.map((b: any) => ({
        id: b.botId,
        name: b.bot.name,
        pages: Array.isArray(b.pagePermissions) ? b.pagePermissions : ["BOT_DETAIL"]
      }))
    }))
  });
});

router.delete("/team/invites/:id", async (req: Request, res: Response) => {
  if (!req.user || req.user.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const invite = await prisma.teamInvite.findFirst({
    where: { id: req.params.id, invitedById: req.user.id }
  });

  if (!invite) {
    return res.status(404).json({ error: "Invite not found" });
  }

  await prisma.teamInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date() }
  });

  return res.json({ ok: true });
});

router.delete("/team/members/:userId", async (req: Request, res: Response) => {
  if (!req.user || req.user.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const targetUserId = req.params.userId;

  await prisma.teamMembership.deleteMany({
    where: {
      userId: targetUserId,
      bot: { userId: req.user.id }
    }
  });

  return res.json({ ok: true });
});

router.put("/team/members/:userId", async (req: Request, res: Response) => {
  if (!req.user || req.user.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = memberBotsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const targetUserId = req.params.userId;
  const requestedAccess = mergeRequestedBotAccess(parsed.data);
  const botIds = Array.from(requestedAccess.keys());

  const ownedBots = await prisma.bot.findMany({
    where: { id: { in: botIds }, userId: req.user.id },
    select: { id: true, name: true, knowledgeSource: true }
  });

  if (ownedBots.length !== botIds.length) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const normalizedBotAccess: Array<{
    botId: string;
    pages: TeamPagePermission[];
  }> = ownedBots.map((bot) => ({
    botId: bot.id,
    pages: normalizeTeamPagesForKnowledgeSource(
      requestedAccess.get(bot.id) || [],
      bot.knowledgeSource === "SHOPIFY" ? "SHOPIFY" : "RAG"
    )
  }));

  const samePages = (a: TeamPagePermission[], b: TeamPagePermission[]) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort().join("|");
    const sb = [...b].sort().join("|");
    return sa === sb;
  };

  await prisma.$transaction(async (tx) => {
    const existing = await tx.teamMembership.findMany({
      where: {
        userId: targetUserId,
        bot: { userId: req.user!.id }
      },
      select: { botId: true, pagePermissions: true as any } as any
    });

    const existingByBotId = new Map(existing.map((m: any) => [m.botId, m]));
    const nextIds = new Set(normalizedBotAccess.map((item) => item.botId));

    const toRemove = existing.filter((m) => !nextIds.has(m.botId));
    const toAdd = normalizedBotAccess.filter((item) => !existingByBotId.has(item.botId));
    const toUpdate = normalizedBotAccess.filter((item) => {
      const current = existingByBotId.get(item.botId) as any;
      if (!current) return false;
      const currentPages = Array.isArray(current.pagePermissions)
        ? (current.pagePermissions as TeamPagePermission[])
        : (["BOT_DETAIL"] as TeamPagePermission[]);
      return !samePages(currentPages, item.pages);
    });

    if (toRemove.length > 0) {
      await tx.teamMembership.deleteMany({
        where: {
          userId: targetUserId,
          botId: { in: toRemove.map((m) => m.botId) }
        }
      });
    }

    if (toAdd.length > 0) {
      await tx.teamMembership.createMany({
        data: toAdd.map(({ botId, pages }) => ({
          userId: targetUserId,
          botId,
          grantedById: req.user!.id,
          pagePermissions: pages
        })) as any
      });
    }

    for (const item of toUpdate) {
      await tx.teamMembership.updateMany({
        where: { userId: targetUserId, botId: item.botId },
        data: { pagePermissions: item.pages } as any
      });
    }
  });

  return res.json({ ok: true });
});

export default router;
