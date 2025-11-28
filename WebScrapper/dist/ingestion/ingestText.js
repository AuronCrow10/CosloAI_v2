import { chunkText } from '../chunker/index.js';
import { logger } from '../logger.js';
/**
 * Shared ingestion pipeline:
 *  text -> chunkText -> embedBatch -> insertChunkForClient
 *
 * IMPORTANT: This function assumes `text` is already "cleaned" as you want it
 * and that any minChars filtering happens *before* calling it.
 * That keeps /crawl behaviour identical to your current implementation.
 */
export async function ingestTextForClient(params) {
    const { text, url, domain, client, deps } = params;
    const { config, db, embeddings } = deps;
    const chunks = chunkText(text, url, domain, config.chunking);
    if (chunks.length === 0) {
        logger.info(`No chunks produced for ${url}`);
        return { chunksCreated: 0, chunksStored: 0 };
    }
    const texts = chunks.map((c) => c.text);
    let vectors;
    try {
        vectors = await embeddings.embedBatch(texts, client.embeddingModel);
    }
    catch (err) {
        logger.error(`Embedding failed for URL ${url}`, err);
        throw err;
    }
    let stored = 0;
    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const embedding = vectors[i];
        const row = { ...chunk, embedding };
        try {
            await db.insertChunkForClient(client.id, client.embeddingModel, row);
            // Note: this counts attempts, same as your previous "chunksStored" counter.
            stored += 1;
        }
        catch (err) {
            logger.error('Failed to store chunk in DB', err);
            // Continue with the next chunk
        }
    }
    logger.info(`Ingestion completed for ${url}. chunksCreated=${chunks.length}, chunksStored=${stored}`);
    return { chunksCreated: chunks.length, chunksStored: stored };
}
