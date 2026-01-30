import { embed } from "@rag/embeddings";
import { SqliteStore } from "../packages/vectorstore/src/sqliteStore.js";
import type { VectorStoreFilter } from "../packages/vectorstore/src/store.js";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const collection = getArg("collection");
const q = getArg("q");
const dbPath = getArg("db") ?? ".data/vectorstore.sqlite";
const topK = Number(getArg("topK") ?? "8");

const sourceType = getArg("sourceType");
const sourcePathPrefix = getArg("sourcePathPrefix");

if (!collection || !q) {
  console.error(
    "Usage: pnpm query --collection <id> --q <question> [--topK 8] [--db <sqlitePath>] [--sourceType markdown|code] [--sourcePathPrefix docs/]"
  );
  process.exit(1);
}

console.log("[query] start", { collection, dbPath, topK });

const [queryVector] = await embed([q]);
if (!queryVector) throw new Error("Failed to embed query.");

const store = new SqliteStore(dbPath);
store.init();

const filter: VectorStoreFilter = {};
if (sourceType) filter.allowedSourceTypes = [sourceType];
if (sourcePathPrefix) filter.sourcePathPrefix = sourcePathPrefix;

const results = store.search({
  collections: [collection],
  queryVector,
  topK,
  ...(Object.keys(filter).length > 0 && { filter }),
});

console.log("[query] results:", results.length);

for (const r of results) {
  const md = r.chunk.metadata as any;

  console.log("—".repeat(80));
  console.log(`similarity: ${r.similarity.toFixed(4)}`);
  console.log(`source: ${md.sourcePath}${md.sectionPath ? `  >  ${md.sectionPath}` : ""}`);
  console.log(`type: ${md.sourceType}`);
  console.log("");
  console.log(r.chunk.text.slice(0, 600));
  if (r.chunk.text.length > 600) console.log("…");
}

console.log("—".repeat(80));
