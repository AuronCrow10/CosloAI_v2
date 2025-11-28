/**
 * High-level search helper:
 * - embeds the query using the client's embedding_model,
 * - runs a similarity search against the appropriate table.
 */
export async function searchClientContent(params) {
    const { db, embeddings, client, query, options } = params;
    const model = client.embeddingModel;
    const [queryEmbedding] = await embeddings.embedBatch([query], model);
    const results = await db.searchClientChunks({
        clientId: client.id,
        model,
        queryEmbedding,
        //domain: options?.domain,
        limit: options?.limit ?? 10,
    });
    return results;
}
