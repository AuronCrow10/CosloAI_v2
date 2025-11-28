// src/routes/botKnowledge.ts
import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import {
  createKnowledgeClient,
  crawlDomain,
  ingestDocs
} from "../services/knowledgeClient";

const router = Router();

// For PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20 MB
  }
});

// Make all routes here auth-protected
router.use("/bots", requireAuth);

// Small helper to load bot & ensure it belongs to current user
async function getUserBot(botId: string, userId: string) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId }
  });
  return bot;
}

// Ensure knowledgeClientId exists; create if needed
// NOW also enforces: bot.status must be ACTIVE
async function ensureKnowledgeClient(botId: string, userId: string) {
  const bot = await getUserBot(botId, userId);
  if (!bot) {
    throw new Error("BOT_NOT_FOUND");
  }

  if (bot.status !== "ACTIVE") {
    // Backend guard: only active bots can use knowledge operations
    throw new Error("BOT_NOT_ACTIVE");
  }

  if (bot.knowledgeClientId) {
    return { bot, knowledgeClientId: bot.knowledgeClientId };
  }

  // Create new client in knowledge backend
  const kc = await createKnowledgeClient({
    name: `${bot.userId}-${bot.slug}`,
    domain: bot.domain ?? undefined
  });

  const updated = await prisma.bot.update({
    where: { id: bot.id },
    data: { knowledgeClientId: kc.client.id }
  });

  return { bot: updated, knowledgeClientId: kc.client.id };
}

/**
 * POST /api/bots/:id/knowledge/crawl-domain
 * Body: { domain?: string }
 *
 * Uses bot.domain by default, can be overridden in body.
 */
router.post(
  "/bots/:id/knowledge/crawl-domain",
  async (req: Request, res: Response) => {
    try {
      const botId = req.params.id;
      const userId = req.user!.id;
      const overrideDomain: string | undefined = req.body?.domain;

      const { bot, knowledgeClientId } = await ensureKnowledgeClient(
        botId,
        userId
      );

      const domainToUse = overrideDomain || bot.domain;
      if (!domainToUse) {
        return res
          .status(400)
          .json({ error: "No domain configured for this bot" });
      }

      await crawlDomain({
        clientId: knowledgeClientId,
        domain: domainToUse
      });

      return res.json({
        status: "ok",
        knowledgeClientId,
        domain: domainToUse
      });
    } catch (err: any) {
      console.error("Error in /bots/:id/knowledge/crawl-domain", err);
      if (err instanceof Error) {
        if (err.message === "BOT_NOT_FOUND") {
          return res.status(404).json({ error: "Bot not found" });
        }
        if (err.message === "BOT_NOT_ACTIVE") {
          return res
            .status(400)
            .json({ error: "Bot must be active before crawling knowledge." });
        }
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * POST /api/bots/:id/knowledge/upload-docs
 * multipart/form-data with field: files[]
 */
router.post(
  "/bots/:id/knowledge/upload-docs",
  upload.array("files", 10),
  async (req: Request, res: Response) => {
    try {
      const botId = req.params.id;
      const userId = req.user!.id;

      const { knowledgeClientId } = await ensureKnowledgeClient(
        botId,
        userId
      );

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      await ingestDocs({
        clientId: knowledgeClientId,
        files
      });

      return res.json({
        status: "ok",
        knowledgeClientId,
        files: files.map((f) => f.originalname)
      });
    } catch (err: any) {
      console.error("Error in /bots/:id/knowledge/upload-docs", err);
      if (err instanceof Error) {
        if (err.message === "BOT_NOT_FOUND") {
          return res.status(404).json({ error: "Bot not found" });
        }
        if (err.message === "BOT_NOT_ACTIVE") {
          return res
            .status(400)
            .json({ error: "Bot must be active before uploading documents." });
        }
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
