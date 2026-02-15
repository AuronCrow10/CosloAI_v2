// src/routes/adminConversations.ts
import { Router } from "express";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { ChannelType, ConversationMode } from "@prisma/client";

const router = Router();

const CHANNEL_VALUES: ChannelType[] = [
  "WEB",
  "WHATSAPP",
  "FACEBOOK",
  "INSTAGRAM"
];

const MODE_VALUES: ConversationMode[] = ["AI", "HUMAN"];

function parsePositiveInt(value: unknown, defaultValue: number, max: number): number {
  if (typeof value !== "string") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

type AdminConversationListItem = {
  id: string;
  botId: string;
  channel: ChannelType;
  mode: ConversationMode;
  externalUserId: string;
  lastMessageAt: string;
  createdAt: string;
  messageCount: number;
  latestEval: {
    score: number;
    label: string | null;
    isAuto: boolean;
    createdAt: string;
  } | null;
  bot: {
    id: string;
    name: string;
    slug: string;
    owner: {
      id: string;
      email: string;
      name: string | null;
    };
  };
};

type AdminConversationListResponse = {
  items: AdminConversationListItem[];
  page: number;
  pageSize: number;
  total: number;
};

type AdminBotConversationSummaryItem = {
  id: string;
  name: string;
  slug: string;
  status: string;
  owner: {
    id: string;
    email: string;
    name: string | null;
  };
  conversationCount: number;
  lastMessageAt: string | null;
};

type AdminBotConversationSummaryResponse = {
  items: AdminBotConversationSummaryItem[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * GET /api/admin/conversations
 *
 * Query params:
 *  - q?: string (search in bot name / slug / owner email / external user id)
 *  - botId?: string
 *  - channel?: ChannelType
 *  - mode?: ConversationMode
 *  - page?: number (1-based, default 1)
 *  - pageSize?: number (default 20, max 100)
 */
router.get("/admin/conversations", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q, botId, channel, mode } = req.query as {
      q?: string;
      botId?: string;
      channel?: string;
      mode?: string;
      page?: string;
      pageSize?: string;
    };

    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    const where: any = {};

    if (botId && botId.trim()) {
      where.botId = botId.trim();
    }

    if (channel && CHANNEL_VALUES.includes(channel as ChannelType)) {
      where.channel = channel;
    }

    if (mode && MODE_VALUES.includes(mode as ConversationMode)) {
      where.mode = mode;
    }

    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { externalUserId: { contains: term, mode: "insensitive" as const } },
        { bot: { name: { contains: term, mode: "insensitive" as const } } },
        { bot: { slug: { contains: term, mode: "insensitive" as const } } },
        {
          bot: {
            user: {
              email: { contains: term, mode: "insensitive" as const }
            }
          }
        }
      ];
    }

    const [total, conversations] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: "desc" },
        skip,
        take: pageSize,
        include: {
          bot: {
            select: {
              id: true,
              name: true,
              slug: true,
              user: {
                select: { id: true, email: true, name: true }
              }
            }
          },
          evals: {
            orderBy: { createdAt: "desc" },
            take: 1
          },
          _count: {
            select: { messages: true }
          }
        }
      })
    ]);

    const items: AdminConversationListItem[] = conversations.map((c) => ({
      id: c.id,
      botId: c.botId,
      channel: c.channel,
      mode: c.mode,
      externalUserId: c.externalUserId,
      lastMessageAt: c.lastMessageAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
      messageCount: c._count.messages,
      latestEval: c.evals[0]
        ? {
            score: c.evals[0].score,
            label: c.evals[0].label ?? null,
            isAuto: c.evals[0].isAuto,
            createdAt: c.evals[0].createdAt.toISOString()
          }
        : null,
      bot: {
        id: c.bot.id,
        name: c.bot.name,
        slug: c.bot.slug,
        owner: {
          id: c.bot.user.id,
          email: c.bot.user.email,
          name: c.bot.user.name ?? null
        }
      }
    }));

    const response: AdminConversationListResponse = {
      items,
      page,
      pageSize,
      total
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/conversations:", err);
    return res.status(500).json({ error: "Failed to load conversations" });
  }
});

/**
 * GET /api/admin/conversations/bots
 *
 * Query params:
 *  - q?: string (search in bot name / slug / owner email)
 *  - page?: number (1-based, default 1)
 *  - pageSize?: number (default 20, max 100)
 */
router.get("/admin/conversations/bots", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q } = req.query as {
      q?: string;
      page?: string;
      pageSize?: string;
    };

    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" as const } },
        { slug: { contains: term, mode: "insensitive" as const } },
        { user: { email: { contains: term, mode: "insensitive" as const } } }
      ];
    }

    const [total, bots] = await Promise.all([
      prisma.bot.count({ where }),
      prisma.bot.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          user: {
            select: { id: true, email: true, name: true }
          }
        }
      })
    ]);

    const botIds = bots.map((b) => b.id);
    const convoAgg = botIds.length
      ? await prisma.conversation.groupBy({
          by: ["botId"],
          where: { botId: { in: botIds } },
          _count: { _all: true },
          _max: { lastMessageAt: true }
        })
      : [];

    const convoByBotId = new Map<
      string,
      { count: number; lastMessageAt: Date | null }
    >();
    for (const row of convoAgg) {
      if (!row.botId) continue;
      convoByBotId.set(row.botId, {
        count: row._count._all ?? 0,
        lastMessageAt: row._max.lastMessageAt ?? null
      });
    }

    const items: AdminBotConversationSummaryItem[] = bots.map((b) => {
      const agg = convoByBotId.get(b.id);
      return {
        id: b.id,
        name: b.name,
        slug: b.slug,
        status: b.status,
        owner: {
          id: b.user.id,
          email: b.user.email,
          name: b.user.name ?? null
        },
        conversationCount: agg?.count ?? 0,
        lastMessageAt: agg?.lastMessageAt
          ? agg.lastMessageAt.toISOString()
          : null
      };
    });

    const response: AdminBotConversationSummaryResponse = {
      items,
      page,
      pageSize,
      total
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/conversations/bots:", err);
    return res.status(500).json({ error: "Failed to load bot summaries" });
  }
});

export default router;
