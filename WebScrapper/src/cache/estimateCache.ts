import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import Redis from 'ioredis';
import { AppConfig } from '../types.js';
import { logger } from '../logger.js';

const CACHE_SCHEMA_VERSION = 1;
const ESTIMATE_KEY_PREFIX = 'estimate';
const ESTIMATE_STATUS_KEY_PREFIX = 'estimate_status';

export interface CachedPage {
  url: string;
  domain: string;
  cleanedText: string;
  title?: string;
}

export interface EstimateCacheMeta {
  estimateId: string;
  signature: string;
  domain: string;
  startUrl: string;
  createdAt: string;
  pagesEstimated: number;
  pagesVisited: number;
  pagesCounted: number;
  tokensEstimated: number;
  schemaVersion: number;
}

export interface EstimateCachePayload {
  meta: EstimateCacheMeta;
  pages: CachedPage[];
}

export interface EstimateJobStatusPayload {
  estimateId: string;
  status: 'running' | 'completed' | 'failed';
  domain: string;
  createdAt: string;
  error?: string;
}

let redisClient: Redis | null = null;

function getRedis(config: AppConfig): Redis | null {
  if (!config.cache.redisUrl) return null;
  if (redisClient) return redisClient;

  redisClient = new Redis(config.cache.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  redisClient.on('error', (err) => {
    logger.error('Redis error', err);
  });

  return redisClient;
}

async function ensureRedisConnected(redis: Redis): Promise<boolean> {
  const status = redis.status;
  if (status === 'ready') return true;
  if (status === 'connecting') return true;
  if (status === 'connect' || status === 'reconnecting') return false;
  if (status === 'end') return false;

  try {
    await redis.connect();
    return true;
  } catch (err) {
    logger.warn('Redis connect failed, skipping estimate cache.', err);
    return false;
  }
}

function buildSignatureInput(domain: string, config: AppConfig): Record<string, unknown> {
  const crawl = config.crawl;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    domain: domain.toLowerCase(),
    crawl: {
      maxPages: crawl.maxPages,
      maxDepth: crawl.maxDepth,
      concurrency: crawl.concurrency,
      contentWaitSelector: crawl.contentWaitSelector || '',
      minChars: crawl.minChars,
      enableSitemap: crawl.enableSitemap,
      respectRobotsTxt: crawl.respectRobotsTxt,
    },
    chunking: {
      chunkSizeTokens: config.chunking.chunkSizeTokens,
      chunkOverlapTokens: config.chunking.chunkOverlapTokens,
    },
  };
}

export function buildEstimateSignature(domain: string, config: AppConfig): string {
  const input = buildSignatureInput(domain, config);
  const json = JSON.stringify(input);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function encodePages(pages: CachedPage[]): string {
  const json = JSON.stringify(pages);
  return gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

function decodePages(payload: string): CachedPage[] {
  const buf = Buffer.from(payload, 'base64');
  const json = gunzipSync(buf).toString('utf8');
  return JSON.parse(json) as CachedPage[];
}

function estimateKey(estimateId: string): string {
  return `${ESTIMATE_KEY_PREFIX}:${estimateId}`;
}

function signatureKey(signature: string): string {
  return `${ESTIMATE_KEY_PREFIX}:sig:${signature}`;
}

function estimateStatusKey(estimateId: string): string {
  return `${ESTIMATE_STATUS_KEY_PREFIX}:${estimateId}`;
}

export async function getCachedEstimateBySignature(
  signature: string,
  config: AppConfig,
): Promise<EstimateCachePayload | null> {
  const redis = getRedis(config);
  if (!redis) return null;

  if (!(await ensureRedisConnected(redis))) return null;

  try {
    const estimateId = await redis.get(signatureKey(signature));
    if (!estimateId) return null;
    return await getCachedEstimateById(estimateId, config);
  } catch (err) {
    logger.warn('Failed to read estimate cache by signature.', err);
    return null;
  }
}

export async function getCachedEstimateById(
  estimateId: string,
  config: AppConfig,
): Promise<EstimateCachePayload | null> {
  const redis = getRedis(config);
  if (!redis) return null;

  if (!(await ensureRedisConnected(redis))) return null;

  try {
    const raw = await redis.get(estimateKey(estimateId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { meta: EstimateCacheMeta; pagesGzip: string };
    const pages = decodePages(parsed.pagesGzip);
    return { meta: parsed.meta, pages };
  } catch (err) {
    logger.warn('Failed to read estimate cache by id.', err);
    return null;
  }
}

export async function setCachedEstimate(
  payload: EstimateCachePayload,
  config: AppConfig,
): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;

  if (!(await ensureRedisConnected(redis))) return;

  const ttl = Math.max(60, config.cache.estimateTtlSeconds);
  const body = JSON.stringify({
    meta: payload.meta,
    pagesGzip: encodePages(payload.pages),
  });

  try {
    const multi = redis.multi();
    multi.set(estimateKey(payload.meta.estimateId), body, 'EX', ttl);
    multi.set(signatureKey(payload.meta.signature), payload.meta.estimateId, 'EX', ttl);
    await multi.exec();
  } catch (err) {
    logger.warn('Failed to write estimate cache.', err);
  }
}

export async function consumeCachedEstimate(
  estimateId: string,
  config: AppConfig,
): Promise<EstimateCachePayload | null> {
  const cached = await getCachedEstimateById(estimateId, config);
  if (!cached) return null;

  const redis = getRedis(config);
  if (!redis) return cached;

  if (!(await ensureRedisConnected(redis))) return cached;

  try {
    const multi = redis.multi();
    multi.del(estimateKey(estimateId));
    multi.del(signatureKey(cached.meta.signature));
    await multi.exec();
  } catch (err) {
    logger.warn('Failed to delete estimate cache.', err);
  }

  return cached;
}

export async function deleteCachedEstimateById(
  estimateId: string,
  config: AppConfig,
  signature?: string,
): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;

  if (!(await ensureRedisConnected(redis))) return;

  try {
    const multi = redis.multi();
    multi.del(estimateKey(estimateId));
    if (signature) {
      multi.del(signatureKey(signature));
    }
    await multi.exec();
  } catch (err) {
    logger.warn('Failed to delete estimate cache.', err);
  }
}

export async function getEstimateJobStatus(
  estimateId: string,
  config: AppConfig,
): Promise<EstimateJobStatusPayload | null> {
  const redis = getRedis(config);
  if (!redis) return null;

  if (!(await ensureRedisConnected(redis))) return null;

  try {
    const raw = await redis.get(estimateStatusKey(estimateId));
    if (!raw) return null;
    return JSON.parse(raw) as EstimateJobStatusPayload;
  } catch (err) {
    logger.warn('Failed to read estimate job status.', err);
    return null;
  }
}

export async function setEstimateJobStatus(
  payload: EstimateJobStatusPayload,
  config: AppConfig,
): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;

  if (!(await ensureRedisConnected(redis))) return;

  const ttl = Math.max(60, config.cache.estimateTtlSeconds);
  try {
    await redis.set(
      estimateStatusKey(payload.estimateId),
      JSON.stringify(payload),
      'EX',
      ttl,
    );
  } catch (err) {
    logger.warn('Failed to write estimate job status.', err);
  }
}

export async function clearEstimateJobStatus(
  estimateId: string,
  config: AppConfig,
): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;

  if (!(await ensureRedisConnected(redis))) return;

  try {
    await redis.del(estimateStatusKey(estimateId));
  } catch (err) {
    logger.warn('Failed to clear estimate job status.', err);
  }
}
