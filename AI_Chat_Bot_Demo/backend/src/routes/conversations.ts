// routes/conversations.ts
import { Router, Request, Response } from "express";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import {
  evaluateConversation,
  ConversationEvalResult
} from "../services/conversationAnalyticsService";

const router = Router();

// tutte queste route richiedono l'utente loggato
router.use("/conversations", requireAuth);

/**
 * GET /api/bots/:botId/conversations
 * Ritorna le conversazioni per un bot dell'utente corrente
 * in modo paginato (20 per pagina) con l'ultima valutazione (se esiste).
 *
 * Query params:
 *   - page: numero pagina (1-based, default 1)
 */
router.get(
  "/conversations/bots/:botId",
  async (req: Request, res: Response) => {
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

    // ---- Pagination ----
    const rawPage = Array.isArray(req.query.page)
      ? req.query.page[0]
      : req.query.page;

    const pageStr =
      typeof rawPage === "string" && rawPage.trim() !== ""
        ? rawPage
        : "1";

    let page = parseInt(pageStr, 10);
    if (isNaN(page) || page < 1) page = 1;

    const pageSize = 20; // fixed as requested
    const skip = (page - 1) * pageSize;


    // 2) Count totale + page corrente
    const [totalItems, conversations] = await prisma.$transaction([
      prisma.conversation.count({ where: { botId } }),
      prisma.conversation.findMany({
        where: { botId },
        orderBy: { lastMessageAt: "desc" },
        include: {
          evals: {
            orderBy: { createdAt: "desc" },
            take: 1
          }
        },
        skip,
        take: pageSize
      })
    ]);

    const totalPages =
      totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);

    const items = conversations.map((c) => ({
      id: c.id,
      botId: c.botId,
      channel: c.channel,
      externalUserId: c.externalUserId,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      latestEval: c.evals[0]
        ? {
            score: c.evals[0].score,
            label: c.evals[0].label,
            isAuto: c.evals[0].isAuto,
            createdAt: c.evals[0].createdAt
          }
        : null
    }));

    res.json({
      items,
      page,
      pageSize,
      totalItems,
      totalPages
    });
  }
);

/**
 * GET /api/conversations/:id/messages
 * Ritorna tutti i messaggi di una conversazione,
 * solo se la conversazione appartiene a un bot dell'utente.
 */
router.get(
  "/conversations/:id/messages",
  async (req: Request, res: Response) => {
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
  }
);

/**
 * POST /api/conversations/:id/eval
 * Valuta una singola conversazione.
 */
router.post(
  "/conversations/:id/eval",
  async (req: Request, res: Response) => {
    const { id } = req.params;

    // 1) Carica la conversazione + bot per verificare ownership
    const conversation = await prisma.conversation.findFirst({
      where: { id },
      include: { bot: true }
    });

    if (!conversation || conversation.bot.userId !== req.user!.id) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    try {
      const result = await evaluateConversation(
        conversation.bot.slug,
        conversation.id,
        false
      );

      return res.json(result);
    } catch (err: any) {
      console.error("Failed to evaluate conversation", err);
      const message =
        err?.message ||
        "Failed to evaluate conversation. Please try again later.";
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/conversations/eval-bulk
 *
 * Body:
 *  {
 *    conversationIds: string[]
 *  }
 *
 * Limite: max 20 conversazioni per richiesta.
 */
router.post(
  "/conversations/eval-bulk",
  async (req: Request, res: Response) => {
    const { conversationIds } = req.body as {
      conversationIds?: string[];
    };

    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return res
        .status(400)
        .json({ error: "conversationIds must be a non-empty array." });
    }

    if (conversationIds.length > 20) {
      return res
        .status(400)
        .json({ error: "Cannot evaluate more than 20 conversations at a time." });
    }

    // Carica tutte le conversazioni che appartengono all'utente
    const conversations = await prisma.conversation.findMany({
      where: {
        id: { in: conversationIds },
        bot: { userId: req.user!.id }
      },
      include: { bot: true }
    });

    const convById = new Map(
      conversations.map((c) => [c.id, c])
    );

    type BulkItem = {
      conversationId: string;
      ok: boolean;
      error?: string;
      result?: ConversationEvalResult;
    };

    const results: BulkItem[] = [];

    for (const convId of conversationIds) {
      const conv = convById.get(convId);
      if (!conv) {
        results.push({
          conversationId: convId,
          ok: false,
          error: "Conversation not found or not owned by current user."
        });
        continue;
      }

      try {
        const result = await evaluateConversation(
          conv.bot.slug,
          conv.id,
          false
        );
        results.push({
          conversationId: convId,
          ok: true,
          result
        });
      } catch (err: any) {
        console.error(
          "Failed to evaluate conversation in bulk:",
          convId,
          err
        );
        results.push({
          conversationId: convId,
          ok: false,
          error:
            err?.message ||
            "Failed to evaluate conversation. Please try again later."
        });
      }
    }

    // Risposta semplice: array di risultati
    res.json({ items: results });
  }
);

export default router;
