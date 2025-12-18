// services/emailUsageService.ts

import { prisma } from "../prisma/prisma";

export type EmailUsageKind =
  | "booking_confirmation"
  | "booking_reminder"
  | string;

export async function recordEmailUsage(params: {
  botId: string;
  kind: EmailUsageKind;
  to: string;
}): Promise<void> {
  try {
    await prisma.emailUsage.create({
      data: {
        botId: params.botId,
        kind: params.kind,
        to: params.to
      }
    });
  } catch (err) {
    // Never break main flow because of logging issues
    console.error("[EmailUsage] Failed to record email usage", err);
  }
}

export async function getEmailUsageForBot(params: {
  botId: string;
  from?: Date | null;
  to?: Date | null;
}): Promise<{ count: number }> {
  const where: any = { botId: params.botId };

  if (params.from || params.to) {
    where.createdAt = {};
    if (params.from) where.createdAt.gte = params.from;
    if (params.to) where.createdAt.lt = params.to;
  }

  const count = await prisma.emailUsage.count({ where });
  return { count };
}
