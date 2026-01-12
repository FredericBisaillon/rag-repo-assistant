export type SourceType = "markdown" | "text" | "code";

export type ChunkId = string;
export type DocumentId = string;
export type CollectionId = string;

export interface RawDocument {
  id: DocumentId;
  collection: CollectionId;
  path: string;
  sourceType: SourceType;
  content: string;
}

export interface ChunkMetadata {
  collection: CollectionId;

  sourcePath: string;
  sourceType: SourceType;

  sectionPath?: string;

  language?: string;
  createdAt?: string;
  updatedAt?: string;
  deprecated?: boolean;

  contentHash: string;
}

export interface Chunk {
  id: ChunkId;
  text: string;
  metadata: ChunkMetadata;
}

export interface EmbeddedChunk {
  chunk: Chunk;
  vector: number[];
}

export interface QueryRequest {
  question: string;
  collections: CollectionId[];
}

export interface RetrievedChunk {
  chunk: Chunk;
  similarity: number;
}

export type QueryIntent =
  | "how_to"
  | "explain"
  | "troubleshoot"
  | "decision"
  | "unknown";

export interface RetrievalPlan {
  intent: QueryIntent;

  allowedSourceTypes: SourceType[];
  minSimilarity: number; // seuil gating
  topK: number;

  preferRecent?: boolean;
}

export type AnswerDecision =
  | { kind: "answer"; selected: RetrievedChunk[] }
  | { kind: "refuse"; reason: string };

export interface QueryResponse {
  answer?: string; // plus tard (quand LLM)
  decision: AnswerDecision;
  debug?: {
    plan: RetrievalPlan;
    retrievedCount: number;
  };
}
