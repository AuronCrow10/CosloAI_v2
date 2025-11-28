"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../prisma/prisma");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// tutte queste route richiedono l'utente loggato
router.use("/conversations", auth_1.requireAuth);
/**
 * GET /api/bots/:botId/conversations
 * Ritorna tutte le conversazioni per un bot dell'utente corrente
 */
router.get("/conversations/bots/:botId", async (req, res) => {
    const { botId } = req.params;
    // 1) Sicurezza: verifica che il bot appartenga all'utente loggato
    const bot = await prisma_1.prisma.bot.findFirst({
        where: {
            id: botId,
            userId: req.user.id
        }
    });
    if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
    }
    // 2) Prendi le conversazioni di quel bot
    const conversations = await prisma_1.prisma.conversation.findMany({
        where: { botId },
        orderBy: { lastMessageAt: "desc" }
    });
    res.json(conversations);
});
/**
 * GET /api/conversations/:id/messages
 * Ritorna tutti i messaggi di una conversazione,
 * solo se la conversazione appartiene a un bot dell'utente.
 */
router.get("/conversations/:id/messages", async (req, res) => {
    const { id } = req.params;
    // 1) Carica la conversazione + bot per verificare ownership
    const conversation = await prisma_1.prisma.conversation.findFirst({
        where: { id },
        include: { bot: true }
    });
    if (!conversation || conversation.bot.userId !== req.user.id) {
        return res.status(404).json({ error: "Conversation not found" });
    }
    // 2) Carica i messaggi, ordinati cronologicamente
    const messages = await prisma_1.prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" }
    });
    res.json(messages);
});
exports.default = router;
