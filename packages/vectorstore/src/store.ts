import type { CollectionId, EmbeddedChunk, RetrievedChunk } from "@rag/core";

export type VectorStoreFilter = {
  allowedSourceTypes?: string[];
  sourcePathPrefix?: string;
};

export interface VectorStore {
  init(): void;

  upsertEmbeddedChunks(params: {
    collection: CollectionId;
    items: EmbeddedChunk[];
  }): void;

  search(params: {
    collections: CollectionId[];
    queryVector: number[];
    topK: number;
    filter?: VectorStoreFilter;
  }): RetrievedChunk[];
}
