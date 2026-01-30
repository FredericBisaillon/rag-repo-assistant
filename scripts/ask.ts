import { embed } from "@rag/embeddings";
import { SqliteStore } from "../packages/vectorstore/src/sqliteStore.js";
import type { RetrievedChunk } from "@rag/core";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getArgNumber(name: string, fallback: number): number {
  const v = getArg(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function formatSource(r: RetrievedChunk): string {
  const md = r.chunk.metadata;
  const section = md.sectionPath ? `#${md.sectionPath}` : "";
  return `${md.sourcePath}${section}`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + "\n…";
}

function isLowSignalChunk(r: RetrievedChunk, opts?: { minChars?: number; dropStatus?: boolean }): boolean {
  const md = r.chunk.metadata;

  const text = r.chunk.text.trim();
  const minChars = opts?.minChars ?? 120;
  if (text.length < minChars) return true;

  const dropStatus = opts?.dropStatus ?? true;
  if (dropStatus) {
    const section = (md.sectionPath ?? "").toLowerCase();
    if (section.includes("status")) return true;
  }

  return false;
}

function assembleContext(
  results: RetrievedChunk[],
  opts?: {
    maxChunks?: number;
    maxPerFile?: number;
    maxCharsPerChunk?: number;
    minChars?: number;
    dropStatus?: boolean;
  }
) {
  const maxChunks = opts?.maxChunks ?? 6;
  const maxPerFile = opts?.maxPerFile ?? 2;
  const maxCharsPerChunk = opts?.maxCharsPerChunk ?? 1600;

  const perFileCount = new Map<string, number>();
  const seen = new Set<string>();
  const selected: RetrievedChunk[] = [];

  for (const r of results) {
    const filterOpts: { minChars?: number; dropStatus?: boolean } = {};
    if (opts?.minChars !== undefined) filterOpts.minChars = opts.minChars;
    if (opts?.dropStatus !== undefined) filterOpts.dropStatus = opts.dropStatus;
    
    if (isLowSignalChunk(r, filterOpts)) continue;

    const md = r.chunk.metadata;
    const file = md.sourcePath;
    const sectionKey = md.sectionPath ?? "";
    const dedupKey = `${file}::${sectionKey}`;

    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const count = perFileCount.get(file) ?? 0;
    if (count >= maxPerFile) continue;

    selected.push(r);
    perFileCount.set(file, count + 1);

    if (selected.length >= maxChunks) break;
  }

  const context = selected
    .map((r, i) => {
      const src = formatSource(r);
      const text = truncateText(r.chunk.text, maxCharsPerChunk);
      return `### [S${i + 1}] ${src}\nSimilarity: ${r.similarity.toFixed(4)}\n\n${text}\n`;
    })
    .join("\n");

  return { context, selected };
}

async function generateWithOllama(input: { model: string; system: string; prompt: string }) {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      stream: false,
      options: {
        temperature: 0.2,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama error: ${res.status} ${res.statusText}\n${text}`);
  }

  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

const q = getArg("q");
const collection = getArg("collection");
const dbPath = getArg("dbPath") ?? ".data/vectorstore.sqlite";

const topK = getArgNumber("topK", 8);
const maxChunks = getArgNumber("maxChunks", 6);
const maxPerFile = getArgNumber("maxPerFile", 2);
const minChars = getArgNumber("minChars", 120);
const maxCharsPerChunk = getArgNumber("maxCharsPerChunk", 1600);

const dropStatus = !hasFlag("--keepStatus");

const model = getArg("model") ?? "llama3.1:8b";
const debug = hasFlag("--debug");

if (!q || !collection) {
  console.error(`Usage:
pnpm ask --collection <id> --q "..." \
  [--topK 8] \
  [--dbPath .data/vectorstore.sqlite] \
  [--model llama3.1:8b] \
  [--maxChunks 6] \
  [--maxPerFile 2] \
  [--minChars 120] \
  [--maxCharsPerChunk 1600] \
  [--keepStatus] \
  [--debug]`);
  process.exit(1);
}

console.log("[ask] start", {
  collection,
  dbPath,
  topK,
  model,
  maxChunks,
  maxPerFile,
  minChars,
  maxCharsPerChunk,
  dropStatus,
});

const store = new SqliteStore(dbPath);
store.init();

console.log("[ask] embedding query...");
const [qVec] = await embed([q]);

if (!qVec) {
  throw new Error("Query embedding failed (no vector returned).");
}

console.log("[ask] retrieving topK...");
const results = store.search({
  collections: [collection],
  queryVector: qVec,
  topK,
});

console.log("[ask] retrieved", results.length, "chunks");

const { context, selected } = assembleContext(results, {
  maxChunks,
  maxPerFile,
  maxCharsPerChunk,
  minChars,
  dropStatus,
});

if (debug) {
  console.log("\n=== CONTEXT (debug) ===\n");
  console.log(context);
}

const system = [
  "You are a repo assistant.",
  "Answer ONLY using the provided context.",
  "If the answer is not in the context, say you don't know and ask what file or area to index.",
  "Always cite sources using [S1], [S2], etc.",
].join(" ");

const prompt = [
  `Question:\n${q}\n`,
  `Context:\n${context}\n`,
  "Write a helpful, concise answer. Include citations like [S1].",
].join("\n");

console.log("[ask] generating with ollama...");
const answer = await generateWithOllama({
  model,
  system,
  prompt,
});

console.log("\n=== ANSWER ===\n");
console.log(answer.trim());

console.log("\n=== SOURCES USED ===\n");
selected.forEach((r, i) => {
  console.log(`[S${i + 1}] ${formatSource(r)} (similarity=${r.similarity.toFixed(4)})`);
});

console.log("\n[ask] done ✅");
