import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import { sendMail } from "../services/mailer";

const router = Router();

router.use("/team", requireAuth);

const inviteSchema = z.object({
  email: z.string().email(),
  botIds: z.array(z.string().uuid()).min(1)
});

router.post("/team/invites", async (req: Request, res: Response) => {
  if (!req.user || req.user.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const email = parsed.data.email.toLowerCase().trim();
  const botIds = Array.from(new Set(parsed.data.botIds));

  const ownedBots = await prisma.bot.findMany({
    where: { id: { in: botIds }, userId: req.user.id },
    select: { id: true, name: true }
  });

  if (ownedBots.length !== botIds.length) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const token = randomBytes(32).toString("hex");

  const invite = await prisma.teamInvite.create({
    data: {
      email,
      token,
      invitedById: req.user.id,
      bots: {
        create: botIds.map((botId) => ({ botId }))
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
    bots: invite.bots.map((b) => ({ id: b.botId, name: b.bot.name }))
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
      bots: { id: string; name: string }[];
    }
  >();

  for (const m of memberships) {
    const existing = memberMap.get(m.userId);
    if (existing) {
      existing.bots.push({ id: m.botId, name: m.bot.name });
    } else {
      memberMap.set(m.userId, {
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        lastLoginAt: m.user.lastLoginAt,
        createdAt: m.user.createdAt,
        bots: [{ id: m.botId, name: m.bot.name }]
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
      bots: invite.bots.map((b) => ({ id: b.botId, name: b.bot.name }))
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

export default router;
