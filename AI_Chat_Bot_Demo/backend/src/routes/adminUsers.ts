// src/routes/adminUsers.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const USER_ROLE_VALUES = ["ADMIN", "CLIENT", "REFERRER", "TEAM_MEMBER"] as const;
type UserRole = (typeof USER_ROLE_VALUES)[number];

// Helper to safely parse positive ints from query
function parsePositiveInt(value: unknown, defaultValue: number, max: number): number {
  if (typeof value !== "string") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

type AdminUserListItem = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;

  botsCount: number;
  referralLeadsCount: number;
  isReferralPartner: boolean;

  totalTokensLast30Days: number;
  lastUsageAt: string | null;
};

type AdminUserListResponse = {
  items: AdminUserListItem[];
  page: number;
  pageSize: number;
  total: number;
};

const patchBodySchema = z
  .object({
    role: z.enum(USER_ROLE_VALUES).optional(),
    emailVerified: z.boolean().optional()
  })
  .refine((data) => data.role !== undefined || data.emailVerified !== undefined, {
    message: "At least one field (role, emailVerified) must be provided"
  });

/**
 * GET /api/admin/users
 *
 * Query params:
 *  - q?: string  (search in email/name)
 *  - role?: "ADMIN" | "CLIENT" | "REFERRER"
 *  - page?: number (1-based, default 1)
 *  - pageSize?: number (default 20, max 100)
 */
router.get("/admin/users", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q, role } = req.query as { q?: string; role?: string; page?: string; pageSize?: string };
    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    const where: any = {};

    if (role && USER_ROLE_VALUES.includes(role as UserRole)) {
      where.role = role;
    }

    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { email: { contains: term, mode: "insensitive" as const } },
        { name: { contains: term, mode: "insensitive" as const } }
      ];
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          _count: {
            select: {
              bots: true,
              referralAttributionsAsLead: true
            }
          },
          referralPartner: {
            select: { id: true }
          }
        }
      })
    ]);

    if (users.length === 0) {
      const emptyResponse: AdminUserListResponse = {
        items: [],
        page,
        pageSize,
        total
      };
      return res.json(emptyResponse);
    }

    const userIds = users.map((u) => u.id);
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [tokenAgg, lastUsageAgg] = await Promise.all([
      prisma.openAIUsage.groupBy({
        by: ["userId"],
        where: {
          userId: { in: userIds },
          createdAt: { gte: since }
        },
        _sum: { totalTokens: true }
      }),
      prisma.openAIUsage.groupBy({
        by: ["userId"],
        where: {
          userId: { in: userIds }
        },
        _max: { createdAt: true }
      })
    ]);

    const tokensByUserId = new Map<string, number>();
    for (const row of tokenAgg) {
      if (!row.userId) continue;
      tokensByUserId.set(row.userId, row._sum.totalTokens ?? 0);
    }

    const lastUsageByUserId = new Map<string, Date>();
    for (const row of lastUsageAgg) {
      if (!row.userId) continue;
      if (!row._max.createdAt) continue;
      lastUsageByUserId.set(row.userId, row._max.createdAt);
    }

    const items: AdminUserListItem[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name ?? null,
      role: u.role as UserRole,
      emailVerified: u.emailVerified,
      mfaEnabled: u.mfaEnabled,
      createdAt: u.createdAt.toISOString(),
      botsCount: u._count.bots,
      referralLeadsCount: u._count.referralAttributionsAsLead,
      isReferralPartner: !!u.referralPartner,
      totalTokensLast30Days: tokensByUserId.get(u.id) ?? 0,
      lastUsageAt: lastUsageByUserId.get(u.id)?.toISOString() ?? null
    }));

    const response: AdminUserListResponse = {
      items,
      page,
      pageSize,
      total
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/users:", err);
    return res.status(500).json({ error: "Failed to load users" });
  }
});

/**
 * PATCH /api/admin/users/:id
 * body: { role?: UserRole; emailVerified?: boolean }
 */
router.patch("/admin/users/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const idSchema = z.string().uuid();
  const idParsed = idSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  const userId = idParsed.data;

  const bodyParsed = patchBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: bodyParsed.error.flatten() });
  }

  const { role, emailVerified } = bodyParsed.data;

  try {
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        role: role ?? undefined,
        emailVerified: emailVerified ?? undefined
      }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in PATCH /api/admin/users/:id:", err);
    return res.status(500).json({ error: "Failed to update user" });
  }
});

export default router;
