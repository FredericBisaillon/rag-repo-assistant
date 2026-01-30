// packages/vectorstore/src/sqliteStore.ts

import Database from "better-sqlite3";
import type {
  CollectionId,
  EmbeddedChunk,
  RetrievedChunk,
  ChunkMetadata,
} from "@rag/core";
import type { VectorStore, VectorStoreFilter } from "./store.js";

export type RetrievedChunkWithVector = RetrievedChunk & { vector: number[] };

type SqlRow = {
  chunk_id: string;
  text: string;
  metadata_json: string;
  vector_json: string;
};

function normalizePath(p: string): string {
  // make routing/filtering stable across "./", "\" etc.
  let s = p.replaceAll("\\", "/");
  if (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/")) s = s.slice(1);
  return s;
}

export class SqliteStore implements VectorStore {
  private db: Database.Database;

  constructor(private readonly dbPath: string) {
    this.db = new Database(dbPath);
  }

  init(): void {
    this.db.exec(`PRAGMA journal_mode = WAL;`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        vector_json TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_collection
      ON chunks(collection);
    `);
  }

  upsertEmbeddedChunks(params: {
    collection: CollectionId;
    items: EmbeddedChunk[];
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (chunk_id, collection, text, metadata_json, vector_json)
      VALUES (@chunk_id, @collection, @text, @metadata_json, @vector_json)
      ON CONFLICT(chunk_id) DO UPDATE SET
        collection = excluded.collection,
        text = excluded.text,
        metadata_json = excluded.metadata_json,
        vector_json = excluded.vector_json;
    `);

    const tx = this.db.transaction((items: EmbeddedChunk[]) => {
      for (const it of items) {
        stmt.run({
          chunk_id: it.chunk.id,
          collection: params.collection,
          text: it.chunk.text,
          metadata_json: JSON.stringify(it.chunk.metadata),
          vector_json: JSON.stringify(it.vector),
        });
      }
    });

    tx(params.items);
  }

  search(params: {
    collections: CollectionId[];
    queryVector: number[];
    topK: number;
    filter?: VectorStoreFilter;
    includeVectors?: boolean;
  }): RetrievedChunk[] | RetrievedChunkWithVector[] {
    if (params.collections.length === 0) return [];
    if (params.topK <= 0) return [];

    const placeholders = params.collections.map(() => "?").join(",");

    const rows = this.db
      .prepare(
        `
        SELECT chunk_id, text, metadata_json, vector_json
        FROM chunks
        WHERE collection IN (${placeholders})
      `
      )
      .all(...params.collections) as SqlRow[];

    const filter = params.filter ?? {};
    const scored: Array<RetrievedChunk | RetrievedChunkWithVector> = [];

    const prefixNorm = filter.sourcePathPrefix
      ? normalizePath(filter.sourcePathPrefix)
      : null;

    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as ChunkMetadata;

      if (filter.allowedSourceTypes?.length) {
        if (!filter.allowedSourceTypes.includes(metadata.sourceType)) continue;
      }

      if (prefixNorm) {
        const srcNorm = normalizePath(metadata.sourcePath);
        if (!srcNorm.startsWith(prefixNorm)) continue;
      }

      const vector = JSON.parse(row.vector_json) as number[];
      const similarity = cosineSimilarity(params.queryVector, vector);

      const base: RetrievedChunk = {
        chunk: {
          id: row.chunk_id,
          text: row.text,
          metadata,
        },
        similarity,
      };

      if (params.includeVectors) {
        scored.push({ ...base, vector });
      } else {
        scored.push(base);
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, params.topK) as any;
  }

  close(): void {
    this.db.close();
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }

  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
