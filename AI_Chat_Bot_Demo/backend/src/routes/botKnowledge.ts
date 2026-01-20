// routes/botKnowledge.ts
import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import {
  createKnowledgeClient,
  crawlDomain,
  ingestDocs,
  getCrawlJob,
  estimateCrawl,
  estimateDocs,
  listCrawlJobs,
  deactivateChunksByJob,
  listChunksByJob,
  updateChunkText,
  deleteChunk
} from "../services/knowledgeClient";
import { getPlanUsageForBot } from "../services/planUsageService";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// -----------------------------
// Authenticated routes
// -----------------------------
router.use("/bots", requireAuth);

async function getUserBot(botId: string, userId: string) {
  return prisma.bot.findFirst({ where: { id: botId, userId } });
}

async function ensureKnowledgeClient(botId: string, userId: string) {
  const bot = await getUserBot(botId, userId);
  if (!bot) throw new Error("BOT_NOT_FOUND");
  if (bot.status !== "ACTIVE") throw new Error("BOT_NOT_ACTIVE");

  if (bot.knowledgeClientId) return { bot, knowledgeClientId: bot.knowledgeClientId };

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

// --- Estimate crawl ---
router.post("/bots/:id/knowledge/estimate-crawl", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const overrideDomain: string | undefined = req.body?.domain;

    const { bot } = await ensureKnowledgeClient(botId, userId);

    const domainToUse = overrideDomain || bot.domain;
    if (!domainToUse) return res.status(400).json({ error: "No domain configured for this bot" });

    const data = await estimateCrawl(domainToUse);
    return res.json(data);
  } catch (err: any) {
    console.error("Error in estimate-crawl", err);
    if (err instanceof Error) {
      if (err.message === "BOT_NOT_FOUND") return res.status(404).json({ error: "Bot not found" });
      if (err.message === "BOT_NOT_ACTIVE") return res.status(400).json({ error: "Bot must be active." });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- Start crawl (returns jobId) ---
router.post("/bots/:id/knowledge/crawl-domain", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const overrideDomain: string | undefined = req.body?.domain;
    const confirmed: boolean = req.body?.confirm === true;

    const { bot, knowledgeClientId } = await ensureKnowledgeClient(botId, userId);

    const domainToUse = overrideDomain || bot.domain;

    if (!domainToUse) {
      return res.status(400).json({ error: "No domain configured for this bot" });
    }

    if (!bot.useDomainCrawler) {
      return res.status(400).json({ error: "Domain crawler disabled for this bot" });
    }

    let estimate: any = null;
    try {
      const estimateResp = await estimateCrawl(domainToUse);
      estimate = estimateResp?.estimate ?? null;
    } catch (err) {
      console.error("Error in pre-crawl estimate", err);
    }

    const snapshot = await getPlanUsageForBot(bot.id);
    const limit = snapshot?.monthlyTokenLimit ?? null;
    const usedTokens = snapshot?.usedTokensTotal ?? 0;
    const remainingTokens =
      limit && limit > 0 ? Math.max(limit - usedTokens, 0) : null;

    const requiredTokens =
      estimate && typeof estimate.tokensEstimated === "number"
        ? estimate.tokensEstimated
        : 0;

    if (limit && limit > 0 && remainingTokens != null && requiredTokens > remainingTokens) {
      return res.status(200).json({
        status: "estimate",
        canProceed: false,
        error: "Crawl would exceed the monthly token limit.",
        estimate,
        limit,
        usedTokens,
        remainingTokens,
        requiredTokens
      });
    }

    if (!confirmed) {
      return res.status(200).json({
        status: "estimate",
        canProceed: true,
        estimate,
        limit,
        usedTokens,
        remainingTokens,
        requiredTokens
      });
    }

    const resp = await crawlDomain({
      clientId: knowledgeClientId,
      domain: domainToUse
    });

    // Persist last crawl info (optional: useful elsewhere)
    await prisma.bot.update({
      where: { id: bot.id },
      data: {
        knowledgeLastCrawlJobId: resp.jobId,
        knowledgeLastCrawlDomain: resp.domain,
        knowledgeLastCrawlStartedAt: new Date(),
        knowledgeLastCrawlFinishedAt: null
      }
    });

    return res.json({
      status: resp.status,
      jobId: resp.jobId,
      knowledgeClientId,
      domain: resp.domain,
      estimate
    });
  } catch (err: any) {
    console.error("Error in crawl-domain", err);
    if (err instanceof Error) {
      if (err.message === "BOT_NOT_FOUND") return res.status(404).json({ error: "Bot not found" });
      if (err.message === "BOT_NOT_ACTIVE") {
        return res.status(400).json({ error: "Bot must be active before crawling knowledge." });
      }
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Crawl history (paginated, 10/page)
router.get("/bots/:id/knowledge/crawl-history", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;

    const bot = await getUserBot(botId, userId);
    if (!bot) return res.status(404).json({ error: "Bot not found" });

    if (!bot.knowledgeClientId) {
      return res.json({ page: 1, pageSize: 10, totalItems: 0, totalPages: 1, jobs: [] });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = 10;

    const data = await listCrawlJobs({
      clientId: bot.knowledgeClientId,
      page,
      pageSize
    });

    return res.json(data);
  } catch (err) {
    console.error("Error in crawl-history", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Crawl job status (single job, ownership validated by clientId)
router.get("/bots/:id/knowledge/crawl-status", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const jobId = String(req.query.jobId || "").trim();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const bot = await getUserBot(botId, userId);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (!bot.knowledgeClientId) return res.status(400).json({ error: "Bot has no knowledge client yet" });

    const data = await getCrawlJob(jobId); // { job: ... }
    const job = data?.job;

    // Ownership check: job belongs to same knowledge client
    if (!job || job.clientId !== bot.knowledgeClientId) {
      return res.status(403).json({ error: "Job does not belong to this bot" });
    }

    const status = job.status;
    if ((status === "completed" || status === "failed") && !bot.knowledgeLastCrawlFinishedAt) {
      // Best-effort update (optional)
      try {
        await prisma.bot.update({
          where: { id: bot.id },
          data: { knowledgeLastCrawlFinishedAt: new Date() }
        });
      } catch {
        // ignore
      }
    }

    return res.json(data);
  } catch (err) {
    console.error("Error in crawl-status", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- Deactivate chunks by crawl job ---
router.post("/bots/:id/knowledge/deactivate-job", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const jobId: string | undefined = req.body?.jobId;

    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const bot = await getUserBot(botId, userId);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (!bot.knowledgeClientId) {
      return res.status(400).json({ error: "Bot has no knowledge client yet" });
    }

    const data = await deactivateChunksByJob({
      clientId: bot.knowledgeClientId,
      jobId
    });

    return res.json(data);
  } catch (err) {
    console.error("Error in deactivate-job", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- List chunks for a crawl job ---
router.get("/bots/:id/knowledge/chunks", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const jobId = String(req.query.jobId || "").trim();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const bot = await getUserBot(botId, userId);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (!bot.knowledgeClientId) {
      return res.status(400).json({ error: "Bot has no knowledge client yet" });
    }

    const data = await listChunksByJob({
      clientId: bot.knowledgeClientId,
      jobId
    });

    return res.json(data);
  } catch (err) {
    console.error("Error in list job chunks", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- Update a single chunk ---
router.patch("/bots/:id/knowledge/chunks/:chunkId", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const chunkId = req.params.chunkId;
    const text = String(req.body?.text || "").trim();

    if (!text) return res.status(400).json({ error: "text is required" });

    const bot = await getUserBot(botId, userId);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (!bot.knowledgeClientId) {
      return res.status(400).json({ error: "Bot has no knowledge client yet" });
    }

    const data = await updateChunkText({
      clientId: bot.knowledgeClientId,
      chunkId,
      text
    });

    return res.json(data);
  } catch (err: any) {
    if (err?.response?.status === 409) {
      return res.status(409).json({ error: "Chunk text already exists for this bot" });
    }
    console.error("Error in update chunk", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- Delete a single chunk (hard delete) ---
router.delete("/bots/:id/knowledge/chunks/:chunkId", async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    const userId = req.user!.id;
    const chunkId = req.params.chunkId;

    const bot = await getUserBot(botId, userId);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (!bot.knowledgeClientId) {
      return res.status(400).json({ error: "Bot has no knowledge client yet" });
    }

    const data = await deleteChunk({
      clientId: bot.knowledgeClientId,
      chunkId
    });

    return res.json(data);
  } catch (err) {
    console.error("Error in delete chunk", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- Estimate docs ---
router.post(
  "/bots/:id/knowledge/estimate-docs",
  upload.array("files", 10),
  async (req: Request, res: Response) => {
    try {
      const botId = req.params.id;
      const userId = req.user!.id;

      const { bot, knowledgeClientId } = await ensureKnowledgeClient(botId, userId);

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const data = await estimateDocs({
        clientId: knowledgeClientId,
        files,
        domain: bot.domain ?? null
      });

      return res.json(data);
    } catch (err: any) {
      console.error("Error in estimate-docs", err);
      if (err instanceof Error) {
        if (err.message === "BOT_NOT_FOUND") return res.status(404).json({ error: "Bot not found" });
        if (err.message === "BOT_NOT_ACTIVE") return res.status(400).json({ error: "Bot must be active." });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// --- Upload docs (actual ingest) ---
router.post(
  "/bots/:id/knowledge/upload-docs",
  upload.array("files", 10),
  async (req: Request, res: Response) => {
    try {
      const botId = req.params.id;
      const userId = req.user!.id;

      const { bot, knowledgeClientId } = await ensureKnowledgeClient(botId, userId);

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      if (!bot.usePdfCrawler) {
        return res.status(400).json({ error: "PDF/doc upload disabled for this bot" });
      }

      const resp = await ingestDocs({
        clientId: knowledgeClientId,
        files,
        domain: bot.domain ?? null
      });

      return res.json({
        status: "ok",
        knowledgeClientId,
        files: files.map((f) => f.originalname),
        knowledge: resp
      });
    } catch (err: any) {
      console.error("Error in upload-docs", err);
      if (err instanceof Error) {
        if (err.message === "BOT_NOT_FOUND") return res.status(404).json({ error: "Bot not found" });
        if (err.message === "BOT_NOT_ACTIVE") {
          return res.status(400).json({ error: "Bot must be active before uploading documents." });
        }
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
