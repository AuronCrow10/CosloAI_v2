import { loadConfig } from '../config/index.js';
import { Database } from '../db/index.js';
import { EmbeddingService } from '../embeddings/index.js';
import { crawlDomain } from '../crawler/index.js';
export async function runCrawl(clientId, domain) {
    const config = loadConfig();
    const db = new Database(config.db);
    await db.init();
    const clientInfo = await db.getClientById(clientId);
    if (!clientInfo) {
        throw new Error(`Client not found: ${clientId}`);
    }
    const embeddingService = new EmbeddingService(config.embeddings);
    await crawlDomain(domain, clientInfo, {
        config,
        db,
        embeddings: embeddingService,
    });
    await db.close();
}
