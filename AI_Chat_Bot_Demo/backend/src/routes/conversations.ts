// routes/conversations.ts
import { Router, Request, Response } from "express";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import {
  evaluateConversation,
  ConversationEvalResult
} from "../services/conversationAnalyticsService";
import axios from "axios";
import { config } from "../config";
import { logMessage } from "../services/conversationService";
import { sendGraphText } from "./metaWebhook";



async function sendWhatsappTextForConversation(
  botId: string,
  waUserId: string,
  text: string
): Promise<void> {
  if (!config.whatsappApiBaseUrl) {
    throw new Error("WhatsApp API base URL not configured");
  }

  const channel = await prisma.botChannel.findFirst({
    where: { botId, type: "WHATSAPP" }
  });

  if (!channel) {
    throw new Error("No WhatsApp channel configured for this bot");
  }

  const phoneNumberId = channel.externalId;
  const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
  const accessToken = channel.accessToken || config.whatsappAccessToken;

  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: waUserId,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    }
  );
}


async function resolveMetaUserDisplayName(
  channelType: "FACEBOOK" | "INSTAGRAM",
  botId: string,
  userId: string
): Promise<string | null> {
  if (!config.metaGraphApiBaseUrl) {
    return null;
  }

  // Any page token for this bot & channel type is fine to read user profiles
  const channel = await prisma.botChannel.findFirst({
    where: { botId, type: channelType }
  });

  if (!channel || !channel.accessToken) {
    return null;
  }

  const url = `${config.metaGraphApiBaseUrl}/${userId}`;
  const fields =
    channelType === "FACEBOOK"
      ? "first_name,last_name,name"
      : "username,name";

  try {
    const resp = await axios.get(url, {
      params: {
        access_token: channel.accessToken,
        fields
      },
      timeout: 8000
    });

    const data: any = resp.data || {};

    if (channelType === "FACEBOOK") {
      const fullName =
        data.name ||
        [data.first_name, data.last_name].filter(Boolean).join(" ");
      return fullName || null;
    } else {
      // INSTAGRAM
      const username: string | undefined = data.username;
      const name: string | undefined = data.name;
      return username || name || null;
    }
  } catch (err: any) {
    console.warn("Failed to resolve Meta user display name", {
      channelType,
      botId,
      userId,
      status: err?.response?.status,
      data: err?.response?.data
    });
    return null;
  }
}

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
 * GET /api/conversations/:id/details
 * Returns conversation metadata + human-friendly sender/receiver info
 * (business side vs external user).
 */
router.get(
  "/conversations/:id/details",
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const conversation = await prisma.conversation.findFirst({
      where: { id },
      include: { bot: true }
    });

    if (!conversation || conversation.bot.userId !== req.user!.id) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    let businessTitle: string = conversation.channel;
    let businessSubtitle: string | null = null;
    let userDisplayName: string | null = null;

    // BotChannel is used for "your side" info + Meta tokens
    const channel = await prisma.botChannel.findFirst({
      where: { botId: conversation.botId, type: conversation.channel }
    });

    if (channel) {
      const meta: any = channel.meta || {};

      if (conversation.channel === "WHATSAPP") {
        const displayPhoneNumber =
          meta.displayPhoneNumber || meta.display_phone_number;
        const verifiedName = meta.verifiedName || meta.verified_name;

        businessTitle = "WhatsApp Business";
        businessSubtitle = displayPhoneNumber || channel.externalId;
        if (verifiedName) {
          businessSubtitle = businessSubtitle
            ? `${businessSubtitle} – ${verifiedName}`
            : verifiedName;
        }
      } else if (conversation.channel === "FACEBOOK") {
        businessTitle = "Facebook Page";
        businessSubtitle = meta.pageName || channel.externalId;

        userDisplayName = await resolveMetaUserDisplayName(
          "FACEBOOK",
          conversation.botId,
          conversation.externalUserId
        );
      } else if (conversation.channel === "INSTAGRAM") {
        businessTitle = "Instagram Business";
        businessSubtitle =
          meta.igUsername || meta.igName || meta.pageName || channel.externalId;

        userDisplayName = await resolveMetaUserDisplayName(
          "INSTAGRAM",
          conversation.botId,
          conversation.externalUserId
        );
      } else if (conversation.channel === "WEB") {
        businessTitle = "Website widget";
        businessSubtitle = channel.externalId || null;
      }
    }

    return res.json({
      id: conversation.id,
      botId: conversation.botId,
      channel: conversation.channel,
      externalUserId: conversation.externalUserId,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      business: {
        title: businessTitle,
        subtitle: businessSubtitle
      },
      user: {
        identifier: conversation.externalUserId, // IG/FB PSID, phone, web id…
        displayName: userDisplayName            // IG username, FB name, etc.
      }
    });
  }
);


/**
 * POST /api/conversations/:id/test-send
 *
 * Body: { text: string }
 *
 * Sends a manual test message to the external user for this conversation.
 * Used mainly for Meta App verification.
 */
router.post(
  "/conversations/:id/test-send",
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { text } = req.body as { text?: string };

    const trimmed = (text || "").trim();
    if (!trimmed) {
      return res.status(400).json({ error: "Text is required" });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id },
      include: { bot: true }
    });

    if (!conversation || conversation.bot.userId !== req.user!.id) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    try {
      if (conversation.channel === "WHATSAPP") {
        await sendWhatsappTextForConversation(
          conversation.botId,
          conversation.externalUserId,
          trimmed
        );
      } else if (
        conversation.channel === "FACEBOOK" ||
        conversation.channel === "INSTAGRAM"
      ) {
        const channel = await prisma.botChannel.findFirst({
          where: {
            botId: conversation.botId,
            type: conversation.channel
          }
        });

        if (!channel) {
          return res.status(400).json({
            error: `No ${conversation.channel} channel configured for this bot.`
          });
        }

        const meta = (channel.meta as any) || {};
        let graphTargetId: string | undefined;

        if (conversation.channel === "FACEBOOK") {
          graphTargetId = meta.pageId || channel.externalId;
        } else {
          // For IG, replies go via PAGE ID when using FB login
          graphTargetId = meta.pageId || channel.externalId;
        }

        if (!graphTargetId) {
          return res.status(400).json({
            error: "Missing graph target id for Meta channel."
          });
        }

        const platform = conversation.channel === "FACEBOOK" ? "FB" : "IG";

        const result = await sendGraphText(
          "manual-test", // requestId for logs
          platform,
          channel.id,
          graphTargetId,
          conversation.externalUserId,
          trimmed
        );

        if (!result.ok) {
          console.error("Meta test send failed", result);
          return res
            .status(502)
            .json({ error: "Failed to send message via Meta." });
        }
      } else if (conversation.channel === "WEB") {
        // Nothing to actually "send"; we just log it into the conversation
        // so it shows up in the UI.
      }

      // Always log the assistant message in the conversation history
      await logMessage({
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: trimmed
      });

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("Failed to send test message", err);
      return res
        .status(500)
        .json({ error: "Failed to send test message. Check channel config and tokens." });
    }
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
