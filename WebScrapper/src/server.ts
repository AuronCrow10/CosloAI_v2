import express from 'express';
import { loadConfig } from './config/index.js';
import { Database } from './db/index.js';
import { EmbeddingService } from './embeddings/index.js';
import { searchClientContent } from './search/service.js';
import { runCrawl } from './cli/runCrawl.js';

import multer from 'multer';
import path from 'node:path';

import { extractTextFromBuffer } from './documents/extract.js';
import { ingestTextForClient } from './ingestion/ingestText.js';

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB, tweak if you want
  },
});

const INTERNAL_TOKEN = process.env.KNOWLEDGE_INTERNAL_TOKEN;

// Very simple internal auth: only calls with X-Internal-Token matching env can use these endpoints.
// In dev, if KNOWLEDGE_INTERNAL_TOKEN is not set, we allow everything.
function requireInternalAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!INTERNAL_TOKEN) {
    return next();
  }

  const token = req.header('X-Internal-Token');
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

const config = loadConfig();
const db = new Database(config.db);
const embeddings = new EmbeddingService(config.embeddings);

// inizializzo il DB una volta sola
db.init()
  .then(() => {
    console.log('DB initialized');
  })
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });

app.use((req, _res, next) => {
  console.log('[KB]', req.method, req.url);
  next();
});


// Returns 201 with { client, created: true } or 409 if domain already exists.
app.post('/clients', requireInternalAuth, async (req, res) => {
  try {
    console.log(req.body);
    const {
      name,
      embeddingModel,
      mainDomain,
    }: {
      name?: string;
      embeddingModel?: string;
      mainDomain?: string;
    } = req.body;

    console.log(name);
    console.log(embeddingModel);
    console.log(mainDomain);

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (!mainDomain) {
      return res.status(400).json({ error: 'mainDomain is required' });
    }

    const model =
      embeddingModel === 'text-embedding-3-large'
        ? 'text-embedding-3-large'
        : 'text-embedding-3-small'; // default to small

    try {
      const client = await db.createClient({
        name,
        embeddingModel: model,
        mainDomain,
      });

      return res.status(201).json({
        client,
        created: true,
      });
    } catch (err: any) {
      if (err?.code === 'DUPLICATE_MAIN_DOMAIN') {
        return res.status(409).json({
          error: 'mainDomain already exists for another client',
        });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error in /clients', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});



// Delete a client and all its content (via ON DELETE CASCADE).
app.delete('/clients/:id', requireInternalAuth, async (req, res) => {
  try {
    const clientId = req.params.id;

    // Optional: verify client exists first (not strictly necessary)
    const existing = await db.getClientById(clientId);
    if (!existing) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await db.deleteClientById(clientId);

    return res.status(204).send();
  } catch (err) {
    console.error('Error in DELETE /clients/:id', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});



// 1) Endpoint per lanciare il crawl (fire-and-forget)
app.post('/crawl', requireInternalAuth, async (req, res) => {
  try {
    const { clientId, domain } = req.body as {
      clientId?: string;
      domain?: string;
    };

    if (!clientId || !domain) {
      return res
        .status(400)
        .json({ error: 'clientId and domain are required' });
    }

    // Fire-and-forget: avvia il crawl ma non blocca la response HTTP
    runCrawl(clientId, domain)
      .then(() => {
        console.log(
          `[KB] Crawl completed for client=${clientId}, domain=${domain}`,
        );
      })
      .catch((err) => {
        console.error(
          `[KB] Crawl failed for client=${clientId}, domain=${domain}`,
          err,
        );
      });

    // Rispondi subito per evitare timeout sul frontend
    return res.status(202).json({
      status: 'queued',
      message: 'Crawl started',
      clientId,
      domain,
    });
  } catch (err) {
    console.error('Error in /crawl', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.post(
  '/upload-document',
  requireInternalAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      const { clientId, domain } = req.body as {
        clientId?: string;
        domain?: string;
      };

      if (!clientId) {
        return res.status(400).json({ error: 'clientId is required' });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'file is required' });
      }

      // 1) Load client to know which embedding model to use
      const client = await db.getClientById(clientId);
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }

      // 2) Determine logical "domain" for these chunks
      const sourceDomain = domain || client.mainDomain || 'uploaded-docs';

      const safeName = encodeURIComponent(file.originalname);
      const sourceUrl = `file://${sourceDomain}/${safeName}`;

      // 3) Extract text from file
      let rawText: string;
      try {
        rawText = await extractTextFromBuffer(file.buffer, file.originalname);
      } catch (err: any) {
        console.error('Failed to extract text from uploaded document', err);
        return res.status(400).json({
          error: `Could not extract text: ${err.message || 'unknown error'}`,
        });
      }

      const cleanedText = rawText
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .trim();

      if (!cleanedText || cleanedText.length < config.crawl.minChars) {
        return res.status(200).json({
          status: 'skipped',
          reason: `Document text too short (${cleanedText.length} chars, min=${config.crawl.minChars})`,
        });
      }

      // 4) Reuse the same ingestion pipeline as crawler
      const { chunksCreated, chunksStored } = await ingestTextForClient({
        text: cleanedText,
        url: sourceUrl,
        domain: sourceDomain,
        client,
        deps: { config, db, embeddings },
      });

      if (chunksCreated === 0) {
        return res.status(200).json({
          status: 'skipped',
          reason: 'No chunks produced from document',
        });
      }

      return res.status(200).json({
        status: 'ok',
        message: 'Document processed',
        fileName: file.originalname,
        domain: sourceDomain,
        chunksCreated,
        chunksAttempted: chunksStored,
      });
    } catch (err) {
      console.error('Error in /upload-document', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  },
);

// 2) Endpoint per la search vettoriale
app.post('/search', requireInternalAuth, async (req, res) => {
  console.log('ciao');
  try {
    const { clientId, query, domain, limit } = req.body;

    if (!clientId || !query) {
      return res
        .status(400)
        .json({ error: 'clientId and query are required' });
    }

    console.log(clientId);

    const client = await db.getClientById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log(client);

    const results = await searchClientContent({
      db,
      embeddings,
      client,
      query,
      options: { domain, limit },
    });

    console.log(results);

    return res.json({ results });
  } catch (err) {
    console.error('Error in /search', err);
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
  console.log(`Knowledge backend listening on http://localhost:${PORT}`);
});
