"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const prisma_1 = require("../prisma/prisma");
const router = (0, express_1.Router)();
router.use("/bots/", auth_1.requireAuth);
const channelCreateSchema = zod_1.z.object({
    type: zod_1.z.enum(["WEB", "WHATSAPP", "FACEBOOK", "INSTAGRAM"]),
    externalId: zod_1.z.string(),
    accessToken: zod_1.z.string(),
    meta: zod_1.z.any().optional()
});
const channelUpdateSchema = channelCreateSchema.partial();
// GET /bots/:id/channels
router.get("/bots/:id/channels", async (req, res) => {
    const bot = await prisma_1.prisma.bot.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        include: { channels: true }
    });
    if (!bot)
        return res.status(404).json({ error: "Bot not found" });
    res.json(bot.channels);
});
// POST /bots/:id/channels
router.post("/bots/:id/channels", async (req, res) => {
    const parsed = channelCreateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const bot = await prisma_1.prisma.bot.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!bot)
        return res.status(404).json({ error: "Bot not found" });
    const channel = await prisma_1.prisma.botChannel.create({
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
router.patch("/bots/:id/channels/:channelId", async (req, res) => {
    const parsed = channelUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const channel = await prisma_1.prisma.botChannel.findFirst({
        where: {
            id: req.params.channelId,
            bot: { id: req.params.id, userId: req.user.id }
        }
    });
    if (!channel)
        return res.status(404).json({ error: "Channel not found" });
    const updated = await prisma_1.prisma.botChannel.update({
        where: { id: channel.id },
        data: { ...parsed.data }
    });
    res.json(updated);
});
// DELETE /bots/:id/channels/:channelId
router.delete("/bots/:id/channels/:channelId", async (req, res) => {
    const channel = await prisma_1.prisma.botChannel.findFirst({
        where: {
            id: req.params.channelId,
            bot: { id: req.params.id, userId: req.user.id }
        }
    });
    if (!channel)
        return res.status(404).json({ error: "Channel not found" });
    await prisma_1.prisma.botChannel.delete({ where: { id: channel.id } });
    res.status(204).send();
});
exports.default = router;
