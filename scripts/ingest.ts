import { ingestRepo } from "@rag/ingestion";
import { embed } from "@rag/embeddings";
import { SqliteStore } from "../packages/vectorstore/src/sqliteStore.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

const repoPath = getArg("repo");
const collection = getArg("collection");
const dbPath = getArg("db") ?? ".data/vectorstore.sqlite";

if (!repoPath || !collection) {
  console.error("Usage: pnpm ingest --repo <path> --collection <id> [--db <sqlitePath>]");
  process.exit(1);
}

console.log("[ingest] start", { repoPath, collection, dbPath });

const result = await ingestRepo({ repoPath, collection });

console.log("[ingest] extracted", {
  documents: result.documents.length,
  chunks: result.chunks.length,
});

console.log("[ingest] embedding chunks...");
const texts = result.chunks.map((c) => c.text);
const vectors = await embed(texts);

if (vectors.length !== result.chunks.length) {
  throw new Error(
    `Embedding count mismatch: got ${vectors.length}, expected ${result.chunks.length}`
  );
}

const dim = vectors[0]?.length ?? 0;
for (const v of vectors) {
  if (v.length !== dim) {
    throw new Error(`Inconsistent embedding dimension: expected ${dim}, got ${v.length}`);
  }
}

console.log("[ingest] embeddings ready", { count: vectors.length, dim });

ensureDir(dbPath);
const store = new SqliteStore(dbPath);
store.init();

const items = result.chunks.map((chunk, i) => {
  const vector = vectors[i];
  if (!vector) {
    throw new Error(`Missing embedding for chunk index ${i} (chunkId=${chunk.id})`);
  }
  return { chunk, vector };
});

store.upsertEmbeddedChunks({
  collection: collection as any,
  items,
});

console.log("[ingest] stored in sqlite OK", {
  dbPath,
  collection,
  storedChunks: result.chunks.length,
  sampleChunkId: result.chunks[0]?.id,
});
