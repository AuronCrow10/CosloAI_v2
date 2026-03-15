import { prisma } from "../prisma/prisma";

type UserContext = {
  id: string;
  role: "ADMIN" | "CLIENT" | "REFERRER" | "TEAM_MEMBER";
};

export const TEAM_PAGE_VALUES = [
  "BOT_DETAIL",
  "BOT_KNOWLEDGE",
  "BOT_KNOWLEDGE_JOB",
  "BOT_CHANNELS",
  "BOT_CONVERSATIONS",
  "BOT_SETTINGS",
  "BOT_WHATSAPP_TEMPLATES",
  "BOT_SHOPIFY",
  "BOT_REVENUE_AI"
] as const;

export type TeamPagePermission = (typeof TEAM_PAGE_VALUES)[number];

type BotKnowledgeSource = "RAG" | "SHOPIFY";

export const TEAM_DEFAULT_PAGES: TeamPagePermission[] = ["BOT_DETAIL"];

const TEAM_PAGES_RAG: TeamPagePermission[] = [
  "BOT_DETAIL",
  "BOT_KNOWLEDGE",
  "BOT_KNOWLEDGE_JOB",
  "BOT_CHANNELS",
  "BOT_CONVERSATIONS",
  "BOT_SETTINGS",
  "BOT_WHATSAPP_TEMPLATES"
];

const TEAM_PAGES_SHOPIFY: TeamPagePermission[] = [
  "BOT_DETAIL",
  "BOT_SHOPIFY",
  "BOT_REVENUE_AI",
  "BOT_CHANNELS",
  "BOT_CONVERSATIONS",
  "BOT_WHATSAPP_TEMPLATES"
];

function uniquePages(values: TeamPagePermission[]): TeamPagePermission[] {
  return Array.from(new Set(values));
}

export function allowedTeamPagesForKnowledgeSource(
  knowledgeSource: BotKnowledgeSource
): TeamPagePermission[] {
  return knowledgeSource === "SHOPIFY"
    ? [...TEAM_PAGES_SHOPIFY]
    : [...TEAM_PAGES_RAG];
}

export function normalizeTeamPagesForKnowledgeSource(
  pages: unknown,
  knowledgeSource: BotKnowledgeSource
): TeamPagePermission[] {
  const allowed = new Set(allowedTeamPagesForKnowledgeSource(knowledgeSource));
  const incoming = Array.isArray(pages) ? pages : [];
  const normalized = incoming
    .map((p) => String(p || "").trim().toUpperCase())
    .filter((p): p is TeamPagePermission =>
      (TEAM_PAGE_VALUES as readonly string[]).includes(p)
    )
    .filter((p) => allowed.has(p));

  // Bot detail is always available.
  return uniquePages(["BOT_DETAIL", ...normalized]);
}

export function isTeamPagePermission(value: unknown): value is TeamPagePermission {
  if (typeof value !== "string") return false;
  return (TEAM_PAGE_VALUES as readonly string[]).includes(value);
}

export async function getTeamMembershipForBot(
  userId: string,
  botId: string
): Promise<{ botId: string; pagePermissions: TeamPagePermission[] } | null> {
  const membership = await prisma.teamMembership.findFirst({
    where: { userId, botId },
    select: {
      botId: true,
      // Cast keeps compatibility until Prisma client is regenerated.
      pagePermissions: true as any
    } as any
  });
  if (!membership) return null;

  const rawPages = (membership as any).pagePermissions;
  const pages = Array.isArray(rawPages)
    ? rawPages.filter(isTeamPagePermission)
    : [];

  return {
    botId: membership.botId,
    pagePermissions: uniquePages(["BOT_DETAIL", ...pages])
  };
}

export async function userHasAnyTeamPagePermission(
  user: UserContext,
  botId: string,
  required: TeamPagePermission[]
): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  if (user.role !== "TEAM_MEMBER") return false;

  const membership = await getTeamMembershipForBot(user.id, botId);
  if (!membership) return false;

  const allowed = new Set(membership.pagePermissions);
  return required.some((perm) => allowed.has(perm));
}

export async function userCanAccessBot(
  user: UserContext,
  botId: string
): Promise<boolean> {
  if (user.role === "ADMIN") return true;

  if (user.role === "TEAM_MEMBER") {
    const membership = await prisma.teamMembership.findFirst({
      where: { userId: user.id, botId }
    });
    return !!membership;
  }

  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: user.id },
    select: { id: true }
  });
  return !!bot;
}

export async function listAccessibleBots(user: UserContext) {
  if (user.role === "TEAM_MEMBER") {
    const bots = await prisma.bot.findMany({
      where: {
        teamMemberships: {
          some: {
            userId: user.id
          }
        }
      },
      include: {
        teamMemberships: {
          where: { userId: user.id },
          select: {
            // Cast keeps compatibility until Prisma client is regenerated.
            pagePermissions: true as any
          } as any
        }
      },
      orderBy: { createdAt: "desc" }
    });

    return bots.map((bot: any) => {
      const rawPages =
        bot.teamMemberships && bot.teamMemberships[0]
          ? bot.teamMemberships[0].pagePermissions
          : [];
      const pages = Array.isArray(rawPages)
        ? rawPages.filter(isTeamPagePermission)
        : [];
      return {
        ...bot,
        teamPagePermissions: uniquePages(["BOT_DETAIL", ...pages]),
        teamMemberships: undefined
      };
    });
  }

  return prisma.bot.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" }
  });
}

export async function requireOwnerAccess(
  user: UserContext,
  botId: string
): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  if (user.role === "TEAM_MEMBER") return false;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: user.id },
    select: { id: true }
  });
  return !!bot;
}
