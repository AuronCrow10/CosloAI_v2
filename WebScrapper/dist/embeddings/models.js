/**
 * Map supported models to their embedding dimensions.
 */
export function getModelDimensions(model) {
    switch (model) {
        case 'text-embedding-3-small':
            return 1536;
        case 'text-embedding-3-large':
            return 3072;
        default:
            // Exhaustiveness check
            const _never = model;
            throw new Error(`Unsupported embedding model: ${_never}`);
    }
}
