import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma/prisma";
import { userCanAccessBot } from "../services/teamAccessService";

const router = Router();

router.use("/bots/", requireAuth);

async function canAccessBot(req: Request, botId: string): Promise<boolean> {
  return userCanAccessBot(req.user!, botId);
}

const channelCreateSchema = z.object({
  type: z.enum(["WEB", "WHATSAPP", "FACEBOOK", "INSTAGRAM"]),
  externalId: z.string(),
  accessToken: z.string(),
  meta: z.any().optional()
});

const channelUpdateSchema = channelCreateSchema.partial();

// GET /bots/:id/channels
router.get("/bots/:id/channels", async (req: Request, res: Response) => {
  const access = await canAccessBot(req, req.params.id);
  if (!access) return res.status(404).json({ error: "Bot not found" });

  const bot = await prisma.bot.findUnique({
    where: { id: req.params.id },
    include: { channels: true }
  });
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  res.json(bot.channels);
});

// POST /bots/:id/channels
router.post("/bots/:id/channels", async (req: Request, res: Response) => {
  const parsed = channelCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const access = await canAccessBot(req, req.params.id);
  if (!access) return res.status(404).json({ error: "Bot not found" });

  const bot = await prisma.bot.findUnique({
    where: { id: req.params.id }
  });
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  const channel = await prisma.botChannel.create({
    data: {
      botId: bot.id,
      type: parsed.data.type,
      externalId: parsed.data.externalId,
      accessToken: parsed.data.accessToken,
      meta: parsed.data.meta ?? undefined
    }
  });

  res.status(201).json(channel);
});

// PATCH /bots/:id/channels/:channelId
router.patch(
  "/bots/:id/channels/:channelId",
  async (req: Request, res: Response) => {
    const parsed = channelUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const channel = await prisma.botChannel.findFirst({
      where: {
        id: req.params.channelId,
        bot: { id: req.params.id }
      }
    });
    if (channel) {
      const access = await canAccessBot(req, channel.botId);
      if (!access) return res.status(404).json({ error: "Channel not found" });
    }
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const updated = await prisma.botChannel.update({
      where: { id: channel.id },
      data: { ...parsed.data }
    });

    res.json(updated);
  }
);

// DELETE /bots/:id/channels/:channelId
router.delete(
  "/bots/:id/channels/:channelId",
  async (req: Request, res: Response) => {
    const channel = await prisma.botChannel.findFirst({
      where: {
        id: req.params.channelId,
        bot: { id: req.params.id }
      }
    });
    if (channel) {
      const access = await canAccessBot(req, channel.botId);
      if (!access) return res.status(404).json({ error: "Channel not found" });
    }
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    await prisma.botChannel.delete({ where: { id: channel.id } });
    res.status(204).send();
  }
);

export default router;
