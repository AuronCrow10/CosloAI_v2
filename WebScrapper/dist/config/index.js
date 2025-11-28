import dotenv from 'dotenv';
import { logger } from '../logger.js';
dotenv.config();
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        logger.error(`Missing required environment variable: ${name}`);
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function intEnv(name, defaultValue) {
    const raw = process.env[name];
    if (!raw)
        return defaultValue;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) {
        logger.warn(`Invalid integer for ${name}, using default ${defaultValue}`);
        return defaultValue;
    }
    return n;
}
function boolEnv(name, defaultValue) {
    const raw = process.env[name];
    if (!raw)
        return defaultValue;
    const v = raw.toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}
export function loadConfig() {
    const db = {
        connectionString: requireEnv('DATABASE_URL'),
    };
    const embeddings = {
        apiKey: requireEnv('OPENAI_API_KEY'),
        maxRetries: intEnv('EMBEDDINGS_MAX_RETRIES', 5),
        initialBackoffMs: intEnv('EMBEDDINGS_INITIAL_BACKOFF_MS', 1000),
    };
    const crawl = {
        maxPages: intEnv('CRAWL_MAX_PAGES', 100),
        maxDepth: intEnv('CRAWL_MAX_DEPTH', 3),
        concurrency: intEnv('CRAWL_CONCURRENCY', 5),
        contentWaitSelector: process.env.CRAWL_CONTENT_WAIT_SELECTOR || undefined,
        minChars: intEnv('CRAWL_MIN_CHARS', 500),
        enableSitemap: boolEnv('ENABLE_SITEMAP', true),
    };
    const chunking = {
        chunkSizeTokens: intEnv('CHUNK_SIZE_TOKENS', 900),
        chunkOverlapTokens: intEnv('CHUNK_OVERLAP_TOKENS', 150),
    };
    return { db, embeddings, crawl, chunking };
}
