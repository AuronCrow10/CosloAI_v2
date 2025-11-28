export type EmbeddingModel = 'text-embedding-3-small' | 'text-embedding-3-large';

/**
 * Map supported models to their embedding dimensions.
 */
export function getModelDimensions(model: EmbeddingModel): number {
  switch (model) {
    case 'text-embedding-3-small':
      return 1536;
    case 'text-embedding-3-large':
      return 3072;
    default:
      // Exhaustiveness check
      const _never: never = model;
      throw new Error(`Unsupported embedding model: ${_never}`);
  }
}
