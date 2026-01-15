import { Pool } from 'pg';
import {
  ChunkWithEmbedding,
  Client,
  DbConfig,
  SearchResult,
  CrawlJob,
  CrawlJobStatus,
} from '../types.js';
import { logger } from '../logger.js';
import { EmbeddingModel, getModelDimensions } from '../embeddings/models.js';

type KnowledgeJobType = 'domain' | 'docs';

export class Database {
  private pool: Pool;

  constructor(config: DbConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
    });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const extRes = await client.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
      );
      if (extRes.rowCount === 0) {
        throw new Error(
          "pgvector extension is not enabled. Run `CREATE EXTENSION IF NOT EXISTS vector;`",
        );
      }

      const tablesRes = await client.query<{
        clients: string | null;
        small: string | null;
        large: string | null;
        crawl_jobs: string | null;
      }>(`
        SELECT
          to_regclass('public.clients') AS clients,
          to_regclass('public.page_chunks_small') AS small,
          to_regclass('public.page_chunks_large') AS large,
          to_regclass('public.crawl_jobs') AS crawl_jobs
      `);

      const row = tablesRes.rows[0];
      if (!row || !row.clients || !row.small || !row.large) {
        throw new Error(
          'Required tables (clients, page_chunks_small, page_chunks_large) are missing. Run migrations.',
        );
      }

      if (!row.crawl_jobs) {
        throw new Error(
          'Required table crawl_jobs is missing. Run migration 04-crawl-jobs.sql.',
        );
      }

      logger.info('Connected to PostgreSQL and basic schema checks passed');
    } catch (err) {
      logger.error('Failed to initialize database', err);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---------- CLIENTS ----------

  async getClientById(id: string): Promise<Client | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        name: string;
        embedding_model: string;
        main_domain: string | null;
        created_at: Date;
      }>(
        `
        SELECT id, name, embedding_model, main_domain, created_at
        FROM clients
        WHERE id = $1
        `,
        [id],
      );

      if (res.rowCount === 0) return null;

      const row = res.rows[0];
      if (
        row.embedding_model !== 'text-embedding-3-small' &&
        row.embedding_model !== 'text-embedding-3-large'
      ) {
        throw new Error(
          `Client ${row.id} has unsupported embedding_model="${row.embedding_model}". ` +
            `Allowed values: "text-embedding-3-small", "text-embedding-3-large".`,
        );
      }

      return {
        id: row.id,
        name: row.name,
        embeddingModel: row.embedding_model as EmbeddingModel,
        mainDomain: row.main_domain,
        createdAt: row.created_at,
      };
    } finally {
      client.release();
    }
  }

  async createClient(params: {
    name: string;
    embeddingModel: EmbeddingModel;
    mainDomain?: string | null;
  }): Promise<Client> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        name: string;
        embedding_model: string;
        main_domain: string | null;
        created_at: Date;
      }>(
        `
        INSERT INTO clients (name, embedding_model, main_domain)
        VALUES ($1, $2, $3)
        RETURNING id, name, embedding_model, main_domain, created_at
        `,
        [params.name, params.embeddingModel, params.mainDomain ?? null],
      );

      const row = res.rows[0];

      if (
        row.embedding_model !== 'text-embedding-3-small' &&
        row.embedding_model !== 'text-embedding-3-large'
      ) {
        throw new Error(
          `Client ${row.id} has unsupported embedding_model="${row.embedding_model}".`,
        );
      }

      return {
        id: row.id,
        name: row.name,
        embeddingModel: row.embedding_model as EmbeddingModel,
        mainDomain: row.main_domain,
        createdAt: row.created_at,
      };
    } catch (err: any) {
      if (err?.code === '23505') {
        const e = new Error('DUPLICATE_MAIN_DOMAIN');
        (e as any).code = 'DUPLICATE_MAIN_DOMAIN';
        throw e;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteClientById(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        DELETE FROM clients
        WHERE id = $1
        `,
        [id],
      );
    } finally {
      client.release();
    }
  }

  // ---------- CRAWL JOBS ----------

  async createCrawlJob(params: {
    clientId: string;
    domain: string;
    startUrl: string;
    totalPagesEstimated: number | null;

    // NEW
    jobType?: KnowledgeJobType;
    initialStatus?: CrawlJobStatus; // default queued
  }): Promise<CrawlJob> {
    const jobType: KnowledgeJobType = params.jobType ?? 'domain';
    const initialStatus: CrawlJobStatus = params.initialStatus ?? 'queued';

    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        client_id: string;
        domain: string;
        start_url: string;
        status: CrawlJobStatus;
        job_type: KnowledgeJobType;
        is_active: boolean;
        total_pages_estimated: number | null;
        pages_visited: number;
        pages_stored: number;
        chunks_stored: number;
        error_message: string | null;
        created_at: Date;
        started_at: Date | null;
        finished_at: Date | null;
        updated_at: Date;
      }>(
        `
        INSERT INTO crawl_jobs (
          client_id, domain, start_url, status, job_type, total_pages_estimated,
          started_at, finished_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          CASE WHEN $4 = 'running' THEN NOW() ELSE NULL END,
          CASE WHEN $4 IN ('completed','failed') THEN NOW() ELSE NULL END
        )
        RETURNING
          id, client_id, domain, start_url, status, job_type,
          is_active, total_pages_estimated, pages_visited, pages_stored, chunks_stored,
          error_message, created_at, started_at, finished_at, updated_at
        `,
        [
          params.clientId,
          params.domain,
          params.startUrl,
          initialStatus,
          jobType,
          params.totalPagesEstimated,
        ],
      );

      const row = res.rows[0];
      return {
        id: row.id,
        clientId: row.client_id,
        domain: row.domain,
        startUrl: row.start_url,
        status: row.status,
        isActive: row.is_active,
        totalPagesEstimated: row.total_pages_estimated,
        pagesVisited: row.pages_visited,
        pagesStored: row.pages_stored,
        chunksStored: row.chunks_stored,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,

        // NEW (requires you to add to CrawlJob type)
        jobType: row.job_type as any,
      } as CrawlJob;
    } finally {
      client.release();
    }
  }

  async markCrawlJobRunning(jobId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE crawl_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
        `,
        [jobId],
      );
    } finally {
      client.release();
    }
  }

  async updateCrawlJobTotals(jobId: string, totalPagesEstimated: number | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE crawl_jobs
        SET total_pages_estimated = $2,
            updated_at = NOW()
        WHERE id = $1
        `,
        [jobId, totalPagesEstimated],
      );
    } finally {
      client.release();
    }
  }

  async updateCrawlJobProgress(params: {
    jobId: string;
    pagesVisited: number;
    pagesStored: number;
    chunksStored: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE crawl_jobs
        SET pages_visited = $2,
            pages_stored  = $3,
            chunks_stored = $4,
            updated_at = NOW()
        WHERE id = $1
        `,
        [params.jobId, params.pagesVisited, params.pagesStored, params.chunksStored],
      );
    } finally {
      client.release();
    }
  }

  async markCrawlJobCompleted(jobId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE crawl_jobs
        SET status = 'completed',
            finished_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        `,
        [jobId],
      );
    } finally {
      client.release();
    }
  }

  async markCrawlJobFailed(jobId: string, errorMessage: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE crawl_jobs
        SET status = 'failed',
            error_message = $2,
            finished_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        `,
        [jobId, errorMessage.slice(0, 2000)],
      );
    } finally {
      client.release();
    }
  }

  async getCrawlJobById(jobId: string): Promise<CrawlJob | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        client_id: string;
        domain: string;
        start_url: string;
        status: CrawlJobStatus;
        job_type: KnowledgeJobType;
        is_active: boolean;
        total_pages_estimated: number | null;
        pages_visited: number;
        pages_stored: number;
        chunks_stored: number;
        error_message: string | null;
        created_at: Date;
        started_at: Date | null;
        finished_at: Date | null;
        updated_at: Date;
      }>(
        `
        SELECT
          id, client_id, domain, start_url, status, job_type,
          is_active, total_pages_estimated, pages_visited, pages_stored, chunks_stored,
          error_message, created_at, started_at, finished_at, updated_at
        FROM crawl_jobs
        WHERE id = $1
        `,
        [jobId],
      );

      if (res.rowCount === 0) return null;

      const row = res.rows[0];
      return {
        id: row.id,
        clientId: row.client_id,
        domain: row.domain,
        startUrl: row.start_url,
        status: row.status,
        isActive: row.is_active,
        totalPagesEstimated: row.total_pages_estimated,
        pagesVisited: row.pages_visited,
        pagesStored: row.pages_stored,
        chunksStored: row.chunks_stored,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,

        // NEW (requires you to add to CrawlJob type)
        jobType: row.job_type as any,
      } as CrawlJob;
    } finally {
      client.release();
    }
  }

  async countCrawlJobsByClientId(clientId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ count: string }>(
        `
        SELECT COUNT(*)::text AS count
        FROM crawl_jobs
        WHERE client_id = $1
        `,
        [clientId],
      );
      return Number(res.rows[0]?.count ?? 0);
    } finally {
      client.release();
    }
  }

  async listCrawlJobsByClientIdPaged(params: {
    clientId: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: CrawlJob[]; totalItems: number }> {
    const pageSize = Math.max(1, Math.min(50, params.pageSize));
    const page = Math.max(1, Math.floor(params.page));
    const offset = (page - 1) * pageSize;

    const client = await this.pool.connect();
    try {
      const [countRes, listRes] = await Promise.all([
        client.query<{ count: string }>(
          `
          SELECT COUNT(*)::text AS count
          FROM crawl_jobs
          WHERE client_id = $1
          `,
          [params.clientId],
        ),
        client.query<{
          id: string;
          client_id: string;
          domain: string;
          start_url: string;
          status: CrawlJobStatus;
          job_type: KnowledgeJobType;
          is_active: boolean;
          total_pages_estimated: number | null;
          pages_visited: number;
          pages_stored: number;
          chunks_stored: number;
          error_message: string | null;
          created_at: Date;
          started_at: Date | null;
          finished_at: Date | null;
          updated_at: Date;
        }>(
          `
          SELECT
            id, client_id, domain, start_url, status, job_type,
            is_active, total_pages_estimated, pages_visited, pages_stored, chunks_stored,
            error_message, created_at, started_at, finished_at, updated_at
          FROM crawl_jobs
          WHERE client_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3
          `,
          [params.clientId, pageSize, offset],
        ),
      ]);

      const totalItems = Number(countRes.rows[0]?.count ?? 0);
      const items = listRes.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        domain: row.domain,
        startUrl: row.start_url,
        status: row.status,
        isActive: row.is_active,
        totalPagesEstimated: row.total_pages_estimated,
        pagesVisited: row.pages_visited,
        pagesStored: row.pages_stored,
        chunksStored: row.chunks_stored,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,

        // NEW
        jobType: row.job_type,
      })) as any as CrawlJob[];

      return { items, totalItems };
    } finally {
      client.release();
    }
  }

  async markCrawlJobDeactivated(jobId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE crawl_jobs
        SET is_active = false,
            updated_at = NOW()
        WHERE id = $1
        `,
        [jobId],
      );
    } finally {
      client.release();
    }
  }

  async sumClientTokensUsedBetween(params: {
    clientId: string;
    from: Date;
    to: Date;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ total_tokens: string | null }>(
        `
        SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM client_usage
        WHERE client_id = $1
          AND created_at >= $2::timestamptz
          AND created_at <= $3::timestamptz
        `,
        [params.clientId, params.from, params.to],
      );
      return Number(res.rows[0]?.total_tokens ?? 0);
    } catch (err) {
      logger.warn('sumClientTokensUsedBetween failed (returning 0)', err);
      return 0;
    } finally {
      client.release();
    }
  }

  // ---------- PAGE CHUNKS (SMALL / LARGE) ----------
  private getTableForModel(model: EmbeddingModel): { tableName: string; dims: number } {
    const dims = getModelDimensions(model);
    const tableName =
      model === 'text-embedding-3-small' ? 'page_chunks_small' : 'page_chunks_large';
    return { tableName, dims };
  }

  async insertChunkForClient(
    clientId: string,
    model: EmbeddingModel,
    chunk: ChunkWithEmbedding,
  ): Promise<void> {
    const { tableName, dims } = this.getTableForModel(model);
    const supportsActiveFlag = model === 'text-embedding-3-small';

    if (chunk.embedding.length !== dims) {
      throw new Error(
        `Embedding dimension mismatch: got ${chunk.embedding.length}, expected ${dims} for model "${model}".`,
      );
    }

    const client = await this.pool.connect();
    try {
      const embeddingLiteral = `[${chunk.embedding.join(',')}]`;

      const result = await client.query(
        `
        INSERT INTO ${tableName} (
          id,
          client_id,
          domain,
          url,
          chunk_index,
          chunk_text,
          chunk_hash,
          embedding
        )
        VALUES (
          gen_random_uuid(),
          $1, $2, $3, $4, $5, $6, $7::vector
        )
        ON CONFLICT (client_id, chunk_hash)
        ${supportsActiveFlag ? 'DO UPDATE SET is_active = true' : 'DO NOTHING'}
        RETURNING id
        `,
        [
          clientId,
          chunk.domain,
          chunk.url,
          chunk.chunkIndex,
          chunk.text,
          chunk.chunkHash,
          embeddingLiteral,
        ],
      );

      if (result.rowCount === 0) {
        logger.debug(
          `Duplicate chunk for client ${clientId} (hash=${chunk.chunkHash}) detected in ${tableName}, skipping insert.`,
        );
      }
    } catch (err) {
      logger.error('Failed to insert chunk into DB', err);
      throw err;
    } finally {
      client.release();
    }
  }

  async searchClientChunks(params: {
    clientId: string;
    model: EmbeddingModel;
    queryEmbedding: number[];
    domain?: string;
    limit: number;
  }): Promise<SearchResult[]> {
    const { clientId, model, queryEmbedding, domain, limit } = params;
    const { tableName, dims } = this.getTableForModel(model);
    const supportsActiveFlag = model === 'text-embedding-3-small';

    if (queryEmbedding.length !== dims) {
      throw new Error(
        `Query embedding dimension mismatch: got ${queryEmbedding.length}, expected ${dims} for model "${model}".`,
      );
    }

    const embeddingLiteral = `[${queryEmbedding.join(',')}]`;
    const isLarge = model === 'text-embedding-3-large';

    const client = await this.pool.connect();
    try {
      let sql: string;
      let values: unknown[];

      if (domain) {
        if (isLarge) {
          sql = `
          SELECT
            id,
            client_id,
            domain,
            url,
            chunk_index,
            chunk_text,
            created_at,
            (embedding::halfvec) <-> $3::halfvec AS distance
          FROM ${tableName}
          WHERE client_id = $1
            AND domain = $2
            ${supportsActiveFlag ? 'AND is_active = true' : ''}
          ORDER BY (embedding::halfvec) <-> $3::halfvec
          LIMIT $4
        `;
          values = [clientId, domain, embeddingLiteral, limit];
        } else {
          sql = `
          SELECT
            id,
            client_id,
            domain,
            url,
            chunk_index,
            chunk_text,
            created_at,
            embedding <-> $3::vector AS distance
          FROM ${tableName}
          WHERE client_id = $1
            AND domain = $2
            ${supportsActiveFlag ? 'AND is_active = true' : ''}
          ORDER BY embedding <-> $3::vector
          LIMIT $4
        `;
          values = [clientId, domain, embeddingLiteral, limit];
        }
      } else {
        if (isLarge) {
          sql = `
          SELECT
            id,
            client_id,
            domain,
            url,
            chunk_index,
            chunk_text,
            created_at,
            (embedding::halfvec) <-> $2::halfvec AS distance
          FROM ${tableName}
          WHERE client_id = $1
            ${supportsActiveFlag ? 'AND is_active = true' : ''}
          ORDER BY (embedding::halfvec) <-> $2::halfvec
          LIMIT $3
        `;
          values = [clientId, embeddingLiteral, limit];
        } else {
          sql = `
          SELECT
            id,
            client_id,
            domain,
            url,
            chunk_index,
            chunk_text,
            created_at,
            embedding <-> $2::vector AS distance
          FROM ${tableName}
          WHERE client_id = $1
            ${supportsActiveFlag ? 'AND is_active = true' : ''}
          ORDER BY embedding <-> $2::vector
          LIMIT $3
        `;
          values = [clientId, embeddingLiteral, limit];
        }
      }

      const res = await client.query<{
        id: string;
        client_id: string;
        domain: string;
        url: string;
        chunk_index: number;
        chunk_text: string;
        created_at: Date;
        distance: number;
      }>(sql, values);

      return res.rows.map((row) => {
        const score = 1 / (1 + row.distance);
        return {
          id: row.id,
          clientId: row.client_id,
          domain: row.domain,
          url: row.url,
          chunkIndex: row.chunk_index,
          text: row.chunk_text,
          createdAt: row.created_at,
          score,
        };
      });
    } finally {
      client.release();
    }
  }

  async listChunksForClientByDomain(params: {
    clientId: string;
    domain: string;
  }): Promise<
    {
      id: string;
      url: string;
      chunkIndex: number;
      text: string;
      createdAt: Date;
    }[]
  > {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        url: string;
        chunk_index: number;
        chunk_text: string;
        created_at: Date;
      }>(
        `
        SELECT id, url, chunk_index, chunk_text, created_at
        FROM page_chunks_small
        WHERE client_id = $1
          AND domain = $2
          AND is_active = true
        ORDER BY url ASC, chunk_index ASC
        `,
        [params.clientId, params.domain],
      );
      return res.rows.map((row) => ({
        id: row.id,
        url: row.url,
        chunkIndex: row.chunk_index,
        text: row.chunk_text,
        createdAt: row.created_at,
      }));
    } finally {
      client.release();
    }
  }

  async listChunksForClientByUrl(params: {
    clientId: string;
    url: string;
  }): Promise<
    {
      id: string;
      url: string;
      chunkIndex: number;
      text: string;
      createdAt: Date;
    }[]
  > {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        url: string;
        chunk_index: number;
        chunk_text: string;
        created_at: Date;
      }>(
        `
        SELECT id, url, chunk_index, chunk_text, created_at
        FROM page_chunks_small
        WHERE client_id = $1
          AND url = $2
          AND is_active = true
        ORDER BY chunk_index ASC
        `,
        [params.clientId, params.url],
      );
      return res.rows.map((row) => ({
        id: row.id,
        url: row.url,
        chunkIndex: row.chunk_index,
        text: row.chunk_text,
        createdAt: row.created_at,
      }));
    } finally {
      client.release();
    }
  }

  async updateChunkForClient(params: {
    clientId: string;
    chunkId: string;
    text: string;
    chunkHash: string;
    embedding: number[];
  }): Promise<
    | {
        id: string;
        url: string;
        chunkIndex: number;
        text: string;
        createdAt: Date;
      }
    | null
  > {
    const client = await this.pool.connect();
    try {
      const embeddingLiteral = `[${params.embedding.join(',')}]`;
      const res = await client.query<{
        id: string;
        url: string;
        chunk_index: number;
        chunk_text: string;
        created_at: Date;
      }>(
        `
        UPDATE page_chunks_small
        SET chunk_text = $3,
            chunk_hash = $4,
            embedding = $5::vector,
            is_active = true
        WHERE id = $1
          AND client_id = $2
        RETURNING id, url, chunk_index, chunk_text, created_at
        `,
        [params.chunkId, params.clientId, params.text, params.chunkHash, embeddingLiteral],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        url: row.url,
        chunkIndex: row.chunk_index,
        text: row.chunk_text,
        createdAt: row.created_at,
      };
    } finally {
      client.release();
    }
  }

  async deleteChunkForClient(params: {
    clientId: string;
    chunkId: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `
        DELETE FROM page_chunks_small
        WHERE id = $1
          AND client_id = $2
        `,
        [params.chunkId, params.clientId],
      );
      return (res.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  // ---------- USAGE TRACKING ----------
  async recordUsage(params: {
    clientId: string;
    model: EmbeddingModel;
    operation: string;
    promptTokens: number;
    totalTokens: number;
  }): Promise<void> {
    if (params.totalTokens <= 0 && params.promptTokens <= 0) return;

    const client = await this.pool.connect();
    try {
      await client.query(
        `
        INSERT INTO client_usage (
          client_id,
          model,
          operation,
          prompt_tokens,
          total_tokens
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          params.clientId,
          params.model,
          params.operation,
          params.promptTokens,
          params.totalTokens,
        ],
      );
    } catch (err) {
      logger.error('Failed to record usage', err);
    } finally {
      client.release();
    }
  }

  async getClientUsageSummary(
    clientId: string,
    from: Date | null,
    to: Date | null,
  ): Promise<{
    clientId: string;
    totalPromptTokens: number;
    totalTokens: number;
    byModel: { model: EmbeddingModel; promptTokens: number; totalTokens: number }[];
    byOperation: { operation: string; promptTokens: number; totalTokens: number }[];
  }> {
    const client = await this.pool.connect();
    try {
      const totalRes = await client.query<{
        prompt_tokens: string | null;
        total_tokens: string | null;
      }>(
        `
        SELECT
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM client_usage
        WHERE client_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
        `,
        [clientId, from ?? null, to ?? null],
      );

      const totalRow = totalRes.rows[0];
      const totalPromptTokens = Number(totalRow?.prompt_tokens ?? 0);
      const totalTokens = Number(totalRow?.total_tokens ?? 0);

      const byModelRes = await client.query<{
        model: EmbeddingModel;
        prompt_tokens: string;
        total_tokens: string;
      }>(
        `
        SELECT
          model,
          SUM(prompt_tokens) AS prompt_tokens,
          SUM(total_tokens) AS total_tokens
        FROM client_usage
        WHERE client_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
        GROUP BY model
        ORDER BY model
        `,
        [clientId, from ?? null, to ?? null],
      );

      const byModel = byModelRes.rows.map((row) => ({
        model: row.model,
        promptTokens: Number(row.prompt_tokens),
        totalTokens: Number(row.total_tokens),
      }));

      const byOperationRes = await client.query<{
        operation: string;
        prompt_tokens: string;
        total_tokens: string;
      }>(
        `
        SELECT
          operation,
          SUM(prompt_tokens) AS prompt_tokens,
          SUM(total_tokens) AS total_tokens
        FROM client_usage
        WHERE client_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
        GROUP BY operation
        ORDER BY operation
        `,
        [clientId, from ?? null, to ?? null],
      );

      const byOperation = byOperationRes.rows.map((row) => ({
        operation: row.operation,
        promptTokens: Number(row.prompt_tokens),
        totalTokens: Number(row.total_tokens),
      }));

      return {
        clientId,
        totalPromptTokens,
        totalTokens,
        byModel,
        byOperation,
      };
    } finally {
      client.release();
    }
  }

  async getAllClientsUsageSummary(
    limit: number,
    from: Date | null,
    to: Date | null,
  ): Promise<
    {
      clientId: string;
      name: string;
      totalPromptTokens: number;
      totalTokens: number;
    }[]
  > {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        client_id: string;
        name: string;
        prompt_tokens: string | null;
        total_tokens: string | null;
      }>(
        `
        SELECT
          c.id AS client_id,
          c.name AS name,
          COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(u.total_tokens), 0) AS total_tokens
        FROM clients c
        LEFT JOIN client_usage u
          ON u.client_id = c.id
          AND ($2::timestamptz IS NULL OR u.created_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR u.created_at <= $3::timestamptz)
        GROUP BY c.id, c.name
        ORDER BY COALESCE(SUM(u.total_tokens), 0) DESC
        LIMIT $1
        `,
        [limit, from ?? null, to ?? null],
      );

      return res.rows.map((row) => ({
        clientId: row.client_id,
        name: row.name,
        totalPromptTokens: Number(row.prompt_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
      }));
    } finally {
      client.release();
    }
  }

  async deactivateChunksForClientByUrl(params: {
    clientId: string;
    url: string;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ id: string }>(
        `
        UPDATE page_chunks_small
        SET is_active = false
        WHERE client_id = $1
          AND url = $2
          AND is_active = true
        RETURNING id
        `,
        [params.clientId, params.url],
      );
      return res.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  async deactivateChunksForClientByDomain(params: {
    clientId: string;
    domain: string;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ id: string }>(
        `
        UPDATE page_chunks_small
        SET is_active = false
        WHERE client_id = $1
          AND domain = $2
          AND is_active = true
        RETURNING id
        `,
        [params.clientId, params.domain],
      );
      return res.rowCount ?? 0;
    } finally {
      client.release();
    }
  }
}
