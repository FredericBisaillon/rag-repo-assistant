import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteStore } from "../packages/vectorstore/src/sqliteStore.js";

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

const dbPath = ".data/vectorstore-smoke.sqlite";
ensureDir(dbPath);

const store = new SqliteStore(dbPath);
store.init();

const collection = "docvault" as any;
const now = new Date().toISOString();

store.upsertEmbeddedChunks({
  collection,
  items: [
    {
      chunk: {
        id: "chunk-1",
        text: "Apples are red",
        metadata: {
          collection,
          sourceType: "markdown",
          sourcePath: "README.md",
          contentHash: "hash-1",
        },
      },
      vector: [1, 0, 0],
    },
    {
      chunk: {
        id: "chunk-2",
        text: "Bananas are yellow",
        metadata: {
          collection,
          sourceType: "markdown",
          sourcePath: "docs/fruit.md",
          contentHash: "hash-2",
        },
      },
      vector: [0, 1, 0],
    },
  ],
});

// Query proche de chunk-1
const results = store.search({
  collections: [collection],
  queryVector: [0.9, 0.1, 0],
  topK: 2,
});

console.log("Top results:");
for (const r of results) {
  console.log(`- ${r.chunk.id} | sim=${r.similarity.toFixed(4)} | ${r.chunk.text}`);
}

// Test filtre
const filtered = store.search({
  collections: [collection],
  queryVector: [0.9, 0.1, 0],
  topK: 2,
  filter: { sourcePathPrefix: "docs/" },
});

console.log("\nFiltered (sourcePathPrefix=docs/):");
for (const r of filtered) {
  console.log(`- ${r.chunk.id} | sim=${r.similarity.toFixed(4)} | ${r.chunk.text}`);
}

store.close();
