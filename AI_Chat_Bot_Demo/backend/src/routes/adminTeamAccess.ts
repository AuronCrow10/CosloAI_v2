import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  TeamPagePermission,
  isTeamPagePermission
} from "../services/teamAccessService";

const router = Router();

const querySchema = z.object({
  q: z.string().optional(),
  ownerEmail: z.string().optional(),
  memberEmail: z.string().optional(),
  botId: z.string().uuid().optional(),
  includeInvites: z.enum(["true", "false"]).optional(),
  inviteStatus: z.enum(["all", "active", "used", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

function normalizePages(raw: unknown): TeamPagePermission[] {
  const fromDb = Array.isArray(raw) ? raw.filter(isTeamPagePermission) : [];
  return Array.from(new Set(["BOT_DETAIL", ...fromDb])) as TeamPagePermission[];
}

function containsInsensitive(term: string) {
  return { contains: term, mode: "insensitive" as const };
}

router.get("/admin/team-access", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const {
    q,
    ownerEmail,
    memberEmail,
    botId,
    includeInvites,
    inviteStatus,
    limit
  } = parsed.data;

  const maxRows = limit ?? 200;

  const membershipAnd: any[] = [];
  if (botId) {
    membershipAnd.push({ botId });
  }
  if (ownerEmail?.trim()) {
    membershipAnd.push({
      bot: { user: { email: containsInsensitive(ownerEmail.trim()) } }
    });
  }
  if (memberEmail?.trim()) {
    membershipAnd.push({
      user: { email: containsInsensitive(memberEmail.trim()) }
    });
  }
  if (q?.trim()) {
    const term = q.trim();
    membershipAnd.push({
      OR: [
        { user: { email: containsInsensitive(term) } },
        { user: { name: containsInsensitive(term) } },
        { bot: { name: containsInsensitive(term) } },
        { bot: { slug: containsInsensitive(term) } },
        { bot: { user: { email: containsInsensitive(term) } } }
      ]
    });
  }

  const membershipWhere = membershipAnd.length > 0 ? { AND: membershipAnd } : {};

  const memberships = await prisma.teamMembership.findMany({
    where: membershipWhere as any,
    orderBy: { createdAt: "desc" },
    take: maxRows,
    include: {
      user: {
        select: { id: true, email: true, name: true }
      },
      bot: {
        select: {
          id: true,
          name: true,
          slug: true,
          knowledgeSource: true,
          user: { select: { id: true, email: true, name: true } }
        }
      },
      grantedBy: {
        select: { id: true, email: true, name: true }
      }
    }
  });

  const shouldIncludeInvites = includeInvites !== "false";
  let inviteRows: any[] = [];

  if (shouldIncludeInvites) {
    const inviteAnd: any[] = [];
    if (ownerEmail?.trim()) {
      inviteAnd.push({
        invitedBy: { email: containsInsensitive(ownerEmail.trim()) }
      });
    }
    if (memberEmail?.trim()) {
      inviteAnd.push({
        email: containsInsensitive(memberEmail.trim())
      });
    }
    if (botId) {
      inviteAnd.push({
        bots: { some: { botId } }
      });
    }

    if (inviteStatus === "active") {
      inviteAnd.push({ usedAt: null, revokedAt: null });
    } else if (inviteStatus === "used") {
      inviteAnd.push({ usedAt: { not: null } });
    } else if (inviteStatus === "revoked") {
      inviteAnd.push({ revokedAt: { not: null } });
    }

    if (q?.trim()) {
      const term = q.trim();
      inviteAnd.push({
        OR: [
          { email: containsInsensitive(term) },
          { invitedBy: { email: containsInsensitive(term) } },
          { invitedBy: { name: containsInsensitive(term) } },
          { bots: { some: { bot: { name: containsInsensitive(term) } } } },
          { bots: { some: { bot: { slug: containsInsensitive(term) } } } }
        ]
      });
    }

    const inviteWhere = inviteAnd.length > 0 ? { AND: inviteAnd } : {};

    inviteRows = await prisma.teamInvite.findMany({
      where: inviteWhere as any,
      orderBy: { createdAt: "desc" },
      take: maxRows,
      include: {
        invitedBy: {
          select: { id: true, email: true, name: true }
        },
        bots: {
          include: {
            bot: {
              select: {
                id: true,
                name: true,
                slug: true,
                knowledgeSource: true
              }
            }
          }
        }
      }
    });
  }

  return res.json({
    memberships: memberships.map((m: any) => ({
      id: m.id,
      createdAt: m.createdAt,
      pages: normalizePages(m.pagePermissions),
      owner: m.bot.user,
      member: m.user,
      bot: {
        id: m.bot.id,
        name: m.bot.name,
        slug: m.bot.slug,
        knowledgeSource: m.bot.knowledgeSource
      },
      grantedBy: m.grantedBy
    })),
    invites: inviteRows.map((invite: any) => ({
      id: invite.id,
      email: invite.email,
      createdAt: invite.createdAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      owner: invite.invitedBy,
      bots: (invite.bots || []).map((b: any) => ({
        botId: b.botId,
        pages: normalizePages(b.pagePermissions),
        bot: b.bot
          ? {
              id: b.bot.id,
              name: b.bot.name,
              slug: b.bot.slug,
              knowledgeSource: b.bot.knowledgeSource
            }
          : null
      }))
    })),
    summary: {
      memberships: memberships.length,
      invites: inviteRows.length
    }
  });
});

export default router;
