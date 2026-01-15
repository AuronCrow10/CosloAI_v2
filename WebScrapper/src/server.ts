// server.ts
import express from 'express';
import multer from 'multer';

import { loadConfig } from './config/index.js';
import { Database } from './db/index.js';
import { EmbeddingService } from './embeddings/index.js';
import { searchClientContent } from './search/service.js';
import { crawlDomain, normalizeDomainToStartUrl, extractDomain } from './crawler/index.js';

import { extractTextFromBuffer } from './documents/extract.js';
import { ingestTextForClient } from './ingestion/ingestText.js';
import { chunkText } from './chunker/index.js';
import { tokenize } from './tokenizer/index.js';

import { logger } from './logger.js';
import type {
  CrawlJobPublicView,
  DocsEstimate,
  CrawlEstimate,
  CrawlJob,
  KnowledgeJobType,
} from './types.js';

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const INTERNAL_TOKEN = process.env.KNOWLEDGE_INTERNAL_TOKEN;

function requireInternalAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!INTERNAL_TOKEN) return next();
  const token = req.header('X-Internal-Token');
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

const config = loadConfig();
const db = new Database(config.db);
const embeddings = new EmbeddingService(config.embeddings);

db.init()
  .then(() => logger.info('DB initialized'))
  .catch((err) => {
    logger.error('Failed to init DB', err);
    process.exit(1);
  });

app.use((req, _res, next) => {
  logger.info('[KB]', req.method, req.url);
  next();
});

function clampErrorMessage(msg: string, max = 2000): string {
  const s = String(msg || '');
  return s.length > max ? s.slice(0, max) : s;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Domain used for storage/grouping. Not the user's "origin".
 * - If domain provided => normalize to host
 * - Else if client.mainDomain => normalize to host
 * - Else => "uploaded-docs"
 */
function resolveDocsNamespaceDomain(inputDomain: string | undefined, fallbackMainDomain: string | null | undefined) {
  const raw = (inputDomain || fallbackMainDomain || 'uploaded-docs').trim();
  if (!raw || raw === 'uploaded-docs') return 'uploaded-docs';
  try {
    return extractDomain(raw);
  } catch {
    return raw;
  }
}

function inferJobType(startUrl: string): KnowledgeJobType {
  // Domain crawls are typically http/https start urls.
  // Docs are stored as file://local/<filename>
  if (startUrl.startsWith('file://')) return 'docs';
  return 'domain';
}

function inferFilenameFromStartUrl(startUrl: string): string | null {
  try {
    const u = new URL(startUrl);
    const parts = (u.pathname || '').split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? safeDecodeURIComponent(last) : null;
  } catch {
    const clean = startUrl.split('#')[0].split('?')[0];
    const parts = clean.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? safeDecodeURIComponent(last) : null;
  }
}

async function jobToPublic(job: CrawlJob): Promise<CrawlJobPublicView> {
  const total = job.totalPagesEstimated ?? null;
  const percent =
    total && total > 0
      ? Math.max(0, Math.min(100, Math.floor((job.pagesVisited / total) * 100)))
      : null;

  const jobType = inferJobType(job.startUrl);

  const origin =
    jobType === 'domain'
      ? job.domain
      : inferFilenameFromStartUrl(job.startUrl) || 'Uploaded document';

  let tokensUsed: number | null = null;
  if (job.startedAt) {
    const to = job.finishedAt ?? new Date();
    tokensUsed = await db.sumClientTokensUsedBetween({
      clientId: job.clientId,
      from: job.startedAt,
      to,
    });
  }

  return {
    id: job.id,
    clientId: job.clientId,
    status: job.status,
    isActive: job.isActive ?? true,

    jobType,
    origin,

    domain: job.domain,
    startUrl: job.startUrl,

    pagesVisited: job.pagesVisited,
    pagesStored: job.pagesStored,
    chunksStored: job.chunksStored,
    totalPagesEstimated: job.totalPagesEstimated,
    percent,
    errorMessage: job.errorMessage,
    tokensUsed,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

// --- Clients ---
app.post('/clients', requireInternalAuth, async (req, res) => {
  try {
    const { name, embeddingModel, mainDomain } = req.body as {
      name?: string;
      embeddingModel?: string;
      mainDomain?: string;
    };

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!mainDomain) return res.status(400).json({ error: 'mainDomain is required' });

    const model =
      embeddingModel === 'text-embedding-3-large'
        ? 'text-embedding-3-large'
        : 'text-embedding-3-small';

    try {
      const client = await db.createClient({ name, embeddingModel: model, mainDomain });
      return res.status(201).json({ client, created: true });
    } catch (err: any) {
      if (err?.code === 'DUPLICATE_MAIN_DOMAIN') {
        return res.status(409).json({ error: 'mainDomain already exists for another client' });
      }
      throw err;
    }
  } catch (err) {
    logger.error('Error in /clients', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.delete('/clients/:id', requireInternalAuth, async (req, res) => {
  try {
    const clientId = req.params.id;
    const existing = await db.getClientById(clientId);
    if (!existing) return res.status(404).json({ error: 'Client not found' });
    await db.deleteClientById(clientId);
    return res.status(204).send();
  } catch (err) {
    logger.error('Error in DELETE /clients/:id', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Crawl: create job + run async ---
app.post('/crawl', requireInternalAuth, async (req, res) => {
  try {
    const { clientId, domain } = req.body as { clientId?: string; domain?: string };

    if (!clientId || !domain) {
      return res.status(400).json({ error: 'clientId and domain are required' });
    }

    const client = await db.getClientById(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const startUrl = normalizeDomainToStartUrl(domain);
    const host = extractDomain(domain);

    const job = await db.createCrawlJob({
      clientId,
      domain: domain,
      startUrl,
      totalPagesEstimated: null,
    });

    (async () => {
      try {
        await db.markCrawlJobRunning(job.id);

        await crawlDomain(domain, client, {
          config,
          db,
          embeddings,
          job: {
            id: job.id,
            onTotalsKnown: async (totalPagesEstimated) => {
              await db.updateCrawlJobTotals(job.id, totalPagesEstimated ?? null);
            },
            onProgress: async ({ pagesVisited, pagesStored, chunksStored }) => {
              await db.updateCrawlJobProgress({
                jobId: job.id,
                pagesVisited,
                pagesStored,
                chunksStored,
              });
            },
          },
        });

        await db.markCrawlJobCompleted(job.id);
        logger.info(`[KB] Crawl completed job=${job.id} client=${clientId} domain=${domain}`);
      } catch (err: any) {
        logger.error(`[KB] Crawl failed job=${job.id}`, err);
        await db.markCrawlJobFailed(job.id, clampErrorMessage(err?.message || 'Crawl failed'));
      }
    })().catch((e) => logger.error('Unexpected crawl wrapper failure', e));

    return res.status(202).json({
      status: 'queued',
      jobId: job.id,
      clientId,
      domain: host,
    });
  } catch (err) {
    logger.error('Error in /crawl', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Crawl job status (single) ---
app.get('/crawl/jobs/:jobId', requireInternalAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const job = await db.getCrawlJobById(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json({ job: await jobToPublic(job) });
  } catch (err) {
    logger.error('Error in GET /crawl/jobs/:jobId', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Paginated history ---
app.get('/crawl/jobs', requireInternalAuth, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || '').trim();
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize || 10)));

    const { items, totalItems } = await db.listCrawlJobsByClientIdPaged({
      clientId,
      page,
      pageSize,
    });

    const jobs: CrawlJobPublicView[] = [];
    for (const j of items) jobs.push(await jobToPublic(j));

    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    return res.json({
      page,
      pageSize,
      totalItems,
      totalPages,
      jobs,
    });
  } catch (err) {
    logger.error('Error in GET /crawl/jobs (paginated)', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Estimates ---
app.post('/estimate/crawl', requireInternalAuth, async (req, res) => {
  try {
    const { domain } = req.body as { domain?: string };
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const startUrl = normalizeDomainToStartUrl(domain);
    const host = extractDomain(domain);

    let pagesEstimated = config.crawl.maxPages;
    let urls: string[] = [];
    try {
      const sitemapUrl = new URL(startUrl);
      sitemapUrl.pathname = '/sitemap.xml';
      const r = await fetch(sitemapUrl.toString());
      if (r.ok) {
        const xml = await r.text();
        const $ = (await import('cheerio')).load(xml, { xmlMode: true });
        const found: string[] = [];
        $('url > loc, loc').each((_, el) => {
          const raw = $(el).text().trim();
          if (raw) found.push(raw);
        });
        urls = found
          .map((u) => {
            try {
              const x = new URL(u);
              return x.hostname === host ? x.toString() : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean) as string[];
        if (urls.length > 0) {
          pagesEstimated = Math.min(config.crawl.maxPages, urls.length + 1);
        }
      }
    } catch {
      // ignore
    }

    const sampleUrls = [startUrl, ...urls.slice(0, 9)];
    let samplePages = 0;
    let totalTokens = 0;

    for (const u of sampleUrls) {
      try {
        const r = await fetch(u, { redirect: 'follow' });
        if (!r.ok) continue;
        const html = await r.text();
        const parsed = (await import('./parser/index.js')).parseHtmlToText(html, u, host);
        if (!parsed.cleanedText || parsed.cleanedText.length < config.crawl.minChars) continue;

        const chunks = chunkText(parsed.cleanedText, u, host, config.chunking);
        for (const c of chunks) totalTokens += tokenize(c.text).length;
        samplePages += 1;
      } catch {
        // ignore
      }
    }

    const avgEmbeddingTokensPerPage =
      samplePages > 0 ? Math.round(totalTokens / samplePages) : 0;

    const tokensEstimated =
      avgEmbeddingTokensPerPage > 0 ? avgEmbeddingTokensPerPage * pagesEstimated : 0;

    const estimate: CrawlEstimate = {
      domain: host,
      pagesEstimated,
      samplePages,
      avgEmbeddingTokensPerPage,
      tokensEstimated,
      tokensLow: Math.max(0, Math.round(tokensEstimated * 0.75)),
      tokensHigh: Math.round(tokensEstimated * 1.35),
    };

    return res.json({ estimate });
  } catch (err) {
    logger.error('Error in POST /estimate/crawl', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/estimate/docs', requireInternalAuth, upload.array('files', 10), async (req, res) => {
  try {
    const { clientId, domain } = req.body as { clientId?: string; domain?: string };
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const client = await db.getClientById(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'files are required' });
    }

    const namespaceDomain = resolveDocsNamespaceDomain(domain, client.mainDomain);

    let totalTokensEstimated = 0;
    const outFiles: DocsEstimate['files'] = [];

    for (const f of files) {
      let rawText = '';
      try {
        rawText = await extractTextFromBuffer(f.buffer, f.originalname);
      } catch (e: any) {
        outFiles.push({
          fileName: f.originalname,
          chars: 0,
          chunks: 0,
          tokensEstimated: 0,
          skipped: true,
          reason: `Unsupported or unreadable file: ${e?.message || 'error'}`,
        });
        continue;
      }

      const cleaned = rawText
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .trim();

      if (!cleaned || cleaned.length < config.crawl.minChars) {
        outFiles.push({
          fileName: f.originalname,
          chars: cleaned.length,
          chunks: 0,
          tokensEstimated: 0,
          skipped: true,
          reason: `Text too short (${cleaned.length} chars, min=${config.crawl.minChars})`,
        });
        continue;
      }

      const fakeUrl = `file://local/${encodeURIComponent(f.originalname)}`;
      const chunks = chunkText(cleaned, fakeUrl, namespaceDomain, config.chunking);

      let fileTokens = 0;
      for (const c of chunks) fileTokens += tokenize(c.text).length;

      totalTokensEstimated += fileTokens;

      outFiles.push({
        fileName: f.originalname,
        chars: cleaned.length,
        chunks: chunks.length,
        tokensEstimated: fileTokens,
      });
    }

    const estimate: DocsEstimate = {
      totalTokensEstimated,
      files: outFiles,
    };

    return res.json({ estimate });
  } catch (err) {
    logger.error('Error in POST /estimate/docs', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Ingest docs (canonical): /ingest-docs ---
// Creates a crawl_jobs row PER FILE so the table can show filename correctly.
app.post('/ingest-docs', requireInternalAuth, upload.array('files', 10), async (req, res) => {
  try {
    const { clientId, domain } = req.body as { clientId?: string; domain?: string };
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const client = await db.getClientById(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'files are required' });
    }

    const namespaceDomain = resolveDocsNamespaceDomain(domain, client.mainDomain);

    const results: any[] = [];

    for (const file of files) {
      const startUrl = `file://local/${encodeURIComponent(file.originalname)}`;

      const job = await db.createCrawlJob({
        clientId,
        domain: namespaceDomain,
        startUrl,
        totalPagesEstimated: 1,
      });

      try {
        await db.markCrawlJobRunning(job.id);

        let rawText: string;
        try {
          rawText = await extractTextFromBuffer(file.buffer, file.originalname);
        } catch (err: any) {
          await db.updateCrawlJobProgress({
            jobId: job.id,
            pagesVisited: 1,
            pagesStored: 0,
            chunksStored: 0,
          });
          await db.markCrawlJobFailed(
            job.id,
            clampErrorMessage(`Could not extract text: ${err?.message || 'unknown error'}`),
          );
          results.push({
            fileName: file.originalname,
            status: 'skipped',
            reason: `Could not extract text: ${err?.message || 'unknown error'}`,
            jobId: job.id,
          });
          continue;
        }

        const cleanedText = rawText
          .replace(/\r\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n[ \t]+/g, '\n')
          .trim();

        if (!cleanedText || cleanedText.length < config.crawl.minChars) {
          await db.updateCrawlJobProgress({
            jobId: job.id,
            pagesVisited: 1,
            pagesStored: 0,
            chunksStored: 0,
          });
          await db.markCrawlJobCompleted(job.id);

          results.push({
            fileName: file.originalname,
            status: 'skipped',
            reason: `Document text too short (${cleanedText.length} chars, min=${config.crawl.minChars})`,
            jobId: job.id,
          });
          continue;
        }

        const { chunksCreated, chunksStored } = await ingestTextForClient({
          text: cleanedText,
          url: startUrl,
          domain: namespaceDomain,
          client,
          deps: { config, db, embeddings },
        });

        await db.updateCrawlJobProgress({
          jobId: job.id,
          pagesVisited: 1,
          pagesStored: chunksCreated > 0 ? 1 : 0,
          chunksStored: Number(chunksStored ?? 0),
        });

        await db.markCrawlJobCompleted(job.id);

        results.push({
          fileName: file.originalname,
          status: chunksCreated === 0 ? 'skipped' : 'ok',
          chunksCreated,
          chunksStored,
          jobId: job.id,
        });
      } catch (err: any) {
        logger.error('Error ingesting doc', err);
        await db.markCrawlJobFailed(job.id, clampErrorMessage(err?.message || 'Doc ingest failed'));
        results.push({
          fileName: file.originalname,
          status: 'failed',
          reason: err?.message || 'Doc ingest failed',
          jobId: job.id,
        });
      }
    }

    return res.status(200).json({
      status: 'ok',
      namespaceDomain,
      results,
    });
  } catch (err) {
    logger.error('Error in /ingest-docs', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Backward compatible single-file endpoint: /upload-document ---
app.post('/upload-document', requireInternalAuth, upload.single('file'), async (req, res) => {
  try {
    const { clientId, domain } = req.body as { clientId?: string; domain?: string };
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required' });

    const client = await db.getClientById(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const namespaceDomain = resolveDocsNamespaceDomain(domain, client.mainDomain);
    const startUrl = `file://local/${encodeURIComponent(file.originalname)}`;

    const job = await db.createCrawlJob({
      clientId,
      domain: namespaceDomain,
      startUrl,
      totalPagesEstimated: 1,
    });

    await db.markCrawlJobRunning(job.id);

    let rawText: string;
    try {
      rawText = await extractTextFromBuffer(file.buffer, file.originalname);
    } catch (err: any) {
      await db.updateCrawlJobProgress({
        jobId: job.id,
        pagesVisited: 1,
        pagesStored: 0,
        chunksStored: 0,
      });
      await db.markCrawlJobFailed(
        job.id,
        clampErrorMessage(`Could not extract text: ${err?.message || 'unknown error'}`),
      );
      return res.status(400).json({
        error: `Could not extract text: ${err?.message || 'unknown error'}`,
        jobId: job.id,
      });
    }

    const cleanedText = rawText
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .trim();

    if (!cleanedText || cleanedText.length < config.crawl.minChars) {
      await db.updateCrawlJobProgress({
        jobId: job.id,
        pagesVisited: 1,
        pagesStored: 0,
        chunksStored: 0,
      });
      await db.markCrawlJobCompleted(job.id);

      return res.status(200).json({
        status: 'skipped',
        reason: `Document text too short (${cleanedText.length} chars, min=${config.crawl.minChars})`,
        jobId: job.id,
      });
    }

    const { chunksCreated, chunksStored } = await ingestTextForClient({
      text: cleanedText,
      url: startUrl,
      domain: namespaceDomain,
      client,
      deps: { config, db, embeddings },
    });

    await db.updateCrawlJobProgress({
      jobId: job.id,
      pagesVisited: 1,
      pagesStored: chunksCreated > 0 ? 1 : 0,
      chunksStored: Number(chunksStored ?? 0),
    });

    await db.markCrawlJobCompleted(job.id);

    return res.status(200).json({
      status: 'ok',
      message: 'Document processed',
      fileName: file.originalname,
      namespaceDomain,
      chunksCreated,
      chunksAttempted: chunksStored,
      jobId: job.id,
    });
  } catch (err) {
    logger.error('Error in /upload-document', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Search ---
app.post('/search', requireInternalAuth, async (req, res) => {
  try {
    const { clientId, query, domainInput, limit } = req.body;
    if (!clientId || !query) {
      return res.status(400).json({ error: 'clientId and query are required' });
    }

    const domain = extractDomain(domainInput);

    const client = await db.getClientById(clientId);

    if (!client) return res.status(404).json({ error: 'Client not found' });

    const results = await searchClientContent({
      db,
      embeddings,
      client,
      query,
      options: { domain, limit },
    });

    return res.json({ results });
  } catch (err) {
    logger.error('Error in /search', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// --- Deactivate chunks by crawl job (soft delete) ---
app.post('/chunks/deactivate', requireInternalAuth, async (req, res) => {
  try {
    const { clientId, jobId } = req.body as { clientId?: string; jobId?: string };
    if (!clientId || !jobId) {
      return res.status(400).json({ error: 'clientId and jobId are required' });
    }

    const job = await db.getCrawlJobById(jobId);
    if (!job || job.clientId !== clientId) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobType = inferJobType(job.startUrl);
    let deactivated = 0;

    if (jobType === 'docs') {
      deactivated = await db.deactivateChunksForClientByUrl({
        clientId,
        url: job.startUrl,
      });
    } else {
      const normalizedDomain = extractDomain(job.domain || job.startUrl);
      deactivated = await db.deactivateChunksForClientByDomain({
        clientId,
        domain: normalizedDomain,
      });
    }

    await db.markCrawlJobDeactivated(jobId);

    return res.json({
      status: 'ok',
      jobId,
      jobType,
      deactivated,
    });
  } catch (err) {
    logger.error('Error in POST /chunks/deactivate', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});


// Helper per parse date query params
function parseDateQueryParam(
  value: string | undefined,
  fieldName: string,
  res: express.Response,
): Date | undefined | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    res
      .status(400)
      .json({ error: `Invalid date format for "${fieldName}". Use ISO8601.` });
    return undefined;
  }
  return d;
}

// 3) Endpoint per vedere l'uso dei token per un singolo client
// Supporta:
// - ?clientId=...              → tutto lo storico
// - ?clientId=...&from=...&to=... → intervallo personalizzato
// - ?clientId=...&period=month → mese corrente (real-time)
app.get('/usage', requireInternalAuth, async (req, res) => {
  try {
    const clientId = req.query.clientId as string | undefined;

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const client = await db.getClientById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;
    const period = (req.query.period as string | undefined)?.toLowerCase();

    let from: Date | null = null;
    let to: Date | null = null;

    // If explicit from/to are provided, use them
    if (fromStr) {
      const parsed = parseDateQueryParam(fromStr, 'from', res);
      if (parsed === undefined) return; // error already sent
      from = parsed;
    }
    if (toStr) {
      const parsed = parseDateQueryParam(toStr, 'to', res);
      if (parsed === undefined) return; // error already sent
      to = parsed;
    }

    // If no from/to but period=month, compute current month [startOfMonth, now]
    if (!from && !to && period === 'month') {
      const now = new Date();
      const startOfMonthUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0),
      );
      from = startOfMonthUtc;
      to = now;
    }

    const summary = await db.getClientUsageSummary(clientId, from ?? null, to ?? null);

    return res.json(summary);
  } catch (err) {
    console.error('Error in /usage', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// 4) Endpoint per vedere l'uso dei token per tutti i client
// Supporta:
// - ?limit=50
// - ?from=...&to=...
// - ?period=month (mese corrente)
app.get('/usage/clients', requireInternalAuth, async (req, res) => {
  try {
    const limitRaw = req.query.limit as string | undefined;
    let limit = 100;

    if (limitRaw) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 1000); // hard cap
      }
    }

    const fromStr = req.query.from as string | undefined;
    const toStr = req.query.to as string | undefined;
    const period = (req.query.period as string | undefined)?.toLowerCase();

    let from: Date | null = null;
    let to: Date | null = null;

    if (fromStr) {
      const parsed = parseDateQueryParam(fromStr, 'from', res);
      if (parsed === undefined) return;
      from = parsed;
    }
    if (toStr) {
      const parsed = parseDateQueryParam(toStr, 'to', res);
      if (parsed === undefined) return;
      to = parsed;
    }

    if (!from && !to && period === 'month') {
      const now = new Date();
      const startOfMonthUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0),
      );
      from = startOfMonthUtc;
      to = now;
    }

    const usageList = await db.getAllClientsUsageSummary(
      limit,
      from ?? null,
      to ?? null,
    );

    return res.json({ clients: usageList });
  } catch (err) {
    console.error('Error in /usage/clients', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Knowledge backend listening on http://localhost:${PORT}`);
});
