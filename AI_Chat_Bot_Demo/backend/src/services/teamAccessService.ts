import { prisma } from "../prisma/prisma";

type UserContext = {
  id: string;
  role: "ADMIN" | "CLIENT" | "REFERRER" | "TEAM_MEMBER";
};

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
    return prisma.bot.findMany({
      where: {
        teamMemberships: {
          some: {
            userId: user.id
          }
        }
      },
      orderBy: { createdAt: "desc" }
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
