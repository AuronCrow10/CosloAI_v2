import { Router, Request, Response } from "express";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

// tutte queste route richiedono l'utente loggato
router.use("/conversations", requireAuth);

/**
 * GET /api/bots/:botId/conversations
 * Ritorna tutte le conversazioni per un bot dell'utente corrente
 */
router.get("/conversations/bots/:botId", async (req: Request, res: Response) => {
  const { botId } = req.params;

  // 1) Sicurezza: verifica che il bot appartenga all'utente loggato
  const bot = await prisma.bot.findFirst({
    where: {
      id: botId,
      userId: req.user!.id
    }
  });

  if (!bot) {
    return res.status(404).json({ error: "Bot not found" });
  }

  // 2) Prendi le conversazioni di quel bot
  const conversations = await prisma.conversation.findMany({
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
router.get("/conversations/:id/messages", async (req: Request, res: Response) => {
  const { id } = req.params;

  // 1) Carica la conversazione + bot per verificare ownership
  const conversation = await prisma.conversation.findFirst({
    where: { id },
    include: { bot: true }
  });

  if (!conversation || conversation.bot.userId !== req.user!.id) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  // 2) Carica i messaggi, ordinati cronologicamente
  const messages = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "asc" }
  });

  res.json(messages);
});

export default router;
