import { embed } from "@rag/embeddings";
import { SqliteStore } from "../packages/vectorstore/src/sqliteStore.js";
import type { RetrievedChunk } from "@rag/core";
import type { RetrievedChunkWithVector } from "../packages/vectorstore/src/sqliteStore.js";

/* -----------------------------
   CLI helpers
------------------------------ */
function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

/**
 * Pass WITHOUT the leading "--"
 * Example: hasFlag("debug") checks for "--debug"
 */
function hasFlag(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
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

/* -----------------------------
   Similarity helpers (MMR)
------------------------------ */
function cosine(a: number[], b: number[]): number {
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

/**
 * candidates assumed sorted by similarity(query, chunk) desc
 */
function mmrSelect(
  candidates: RetrievedChunkWithVector[],
  k: number,
  lambda: number
): RetrievedChunkWithVector[] {
  const selected: RetrievedChunkWithVector[] = [];
  const remaining = [...candidates];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      const relevance = c.similarity;

      let redundancy = 0;
      if (selected.length > 0 && c.vector) {
        redundancy = Math.max(...selected.map((s) => (s.vector ? cosine(c.vector!, s.vector) : 0)));
      }

      const mmrScore = lambda * relevance - (1 - lambda) * redundancy;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }

  return selected;
}

/* -----------------------------
   Intent routing (aligned with eval.ts)
------------------------------ */
type RoutePlan = {
  prefixes: string[];
  intent: "tests" | "db" | "migrations" | "openapi" | "auth" | "general";
};

function inferRoutePlan(query: string): RoutePlan {
  const q = query.toLowerCase();
  const hasAny = (words: string[]) => words.some((w) => q.includes(w));

  const isTests = hasAny([
    "integration test",
    "integration tests",
    "vitest",
    "test:db",
    "pnpm test",
    "run the integration tests",
    "run integration tests",
    "run tests",
    "how do i run the tests",
    "how do i run integration tests",
    "how do i run the integration test",
  ]);

  const isDb = hasAny([
    "database",
    "postgres",
    "postgresql",
    "pg pool",
    "pool",
    "connection",
    "connect",
    "access the database",
    "db access",
  ]);

  const isAuth = hasAny(["authentication", "auth", "x-user-id", "jwt", "oauth", "cognito"]);

  const isOpenApi = hasAny(["openapi", "swagger", "typebox"]);

  const isMigrations = hasAny([
    "migration",
    "migrations",
    "migrate",
    "migrating",
    "database migrations",
    "migrations handled",
    "how are database migrations handled",
    "schema changes",
    "schema change",
    "ddl",
    "sql-first",
    "sql files",
    "apply migrations",
  ]);

  // ✅ IMPORTANT: migrations must win over db (queries often include "database migrations")
  if (isTests) return { intent: "tests", prefixes: ["apps/api/README.md"] };

  if (isMigrations)
    return {
      intent: "migrations",
      // ✅ remove apps/docs/README.md (often Next.js template noise)
      prefixes: ["apps/docs/app/adr/", "README.md"],
    };

  if (isOpenApi)
    return {
      intent: "openapi",
      prefixes: ["apps/api/README.md", "apps/docs/app/adr/0002-fastify-typebox-openapi.md"],
    };

  if (isAuth) return { intent: "auth", prefixes: ["apps/api/README.md", "README.md"] };

  if (isDb) return { intent: "db", prefixes: ["README.md", "apps/api/README.md"] };

  return { intent: "general", prefixes: [] };
}

function retrieveWithRouting(params: {
  store: SqliteStore;
  collection: string;
  query: string;
  queryVector: number[];
  topK: number;
  includeVectors: boolean;
}): { plan: RoutePlan; results: Array<RetrievedChunk | RetrievedChunkWithVector> } {
  const plan = inferRoutePlan(params.query);

  const out: Array<RetrievedChunk | RetrievedChunkWithVector> = [];
  const seen = new Set<string>();

  const pushDedup = (items: Array<RetrievedChunk | RetrievedChunkWithVector>) => {
    for (const r of items) {
      if (seen.has(r.chunk.id)) continue;
      seen.add(r.chunk.id);
      out.push(r);
      if (out.length >= params.topK) return;
    }
  };

  const fetch = (filter?: { sourcePathPrefix?: string }) => {
    const searchParams: {
      collections: string[];
      queryVector: number[];
      topK: number;
      includeVectors: boolean;
      filter?: { sourcePathPrefix?: string };
    } = {
      collections: [params.collection],
      queryVector: params.queryVector,
      // align with eval behavior (wider backend fetch)
      topK: Math.max(params.topK, 32),
      includeVectors: params.includeVectors,
    };

    if (filter !== undefined) searchParams.filter = filter;

    return params.store.search(searchParams) as Array<RetrievedChunk | RetrievedChunkWithVector>;
  };

  // 1) routed-first
  for (const prefix of plan.prefixes) {
    pushDedup(fetch({ sourcePathPrefix: prefix }));
    if (out.length >= params.topK) return { plan, results: out };
  }

  // 2) backfill global
  pushDedup(fetch());

  return { plan, results: out.slice(0, params.topK) };
}

/* -----------------------------
   Selection (priority keep + priority boost) + context assembly
------------------------------ */
function isPrioritySource(sourcePath: string, priorityPrefixes: string[]): boolean {
  return priorityPrefixes.some((p) => sourcePath.startsWith(p));
}

function isLowSignalChunk(
  r: RetrievedChunk,
  opts: {
    minChars: number;
    dropStatus: boolean;
    priorityPrefixes: string[];
  }
): boolean {
  const md = r.chunk.metadata;

  // ✅ keep routed sources no matter what
  if (isPrioritySource(md.sourcePath, opts.priorityPrefixes)) return false;

  const text = r.chunk.text.trim();
  if (text.length < opts.minChars) return true;

  if (opts.dropStatus) {
    const section = (md.sectionPath ?? "").toLowerCase();
    if (section.includes("status")) return true;
  }

  return false;
}

function assembleContextFromCandidates(
  candidates: RetrievedChunk[],
  opts: {
    maxChunks: number;
    maxPerFile: number;
    maxCharsPerChunk: number;
    minChars: number;
    dropStatus: boolean;
    priorityPrefixes: string[];
  }
): { context: string; selected: RetrievedChunk[] } {
  const perFileCount = new Map<string, number>();
  const seen = new Set<string>();
  const selected: RetrievedChunk[] = [];

  for (const r of candidates) {
    if (isLowSignalChunk(r, opts)) continue;

    const md = r.chunk.metadata;
    const file = md.sourcePath;
    const sectionKey = md.sectionPath ?? "";
    const dedupKey = `${file}::${sectionKey}`;

    const isPriority = isPrioritySource(file, opts.priorityPrefixes);

    // Dedup rule stays (prevents same section repeated)
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // ✅ Priority BOOST: routed files are not constrained by maxPerFile
    if (!isPriority) {
      const count = perFileCount.get(file) ?? 0;
      if (count >= opts.maxPerFile) continue;
      perFileCount.set(file, count + 1);
    }

    selected.push(r);
    if (selected.length >= opts.maxChunks) break;
  }

  const context = selected
    .map((r, i) => {
      const src = formatSource(r);
      const text = truncateText(r.chunk.text, opts.maxCharsPerChunk);
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
      options: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama error: ${res.status} ${res.statusText}\n${text}`);
  }

  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

/* -----------------------------
   CLI args
------------------------------ */
const q = getArg("q");
const collection = getArg("collection");
const dbPath = getArg("dbPath") ?? ".data/vectorstore.sqlite";

const topK = getArgNumber("topK", 8);
const maxChunks = getArgNumber("maxChunks", 6);
const maxPerFile = getArgNumber("maxPerFile", 2);
const minChars = getArgNumber("minChars", 120);
const maxCharsPerChunk = getArgNumber("maxCharsPerChunk", 1600);

// dropStatus defaults true unless --keepStatus
const dropStatus = !hasFlag("keepStatus");

const model = getArg("model") ?? "llama3.1:8b";
const debug = hasFlag("debug");
const intentDebug = hasFlag("intentDebug");

// MMR options
const useMmr = hasFlag("mmr");
const mmrLambda = getArgNumber("mmrLambda", 0.75);

// k = how many candidates MMR tries to pick (we'll still run selection after)
const k = getArgNumber("k", Math.max(maxChunks, 6));
const minSim = getArgNumber("minSim", useMmr ? 0.55 : 0);

if (!q || !collection) {
  console.error(`Usage:
pnpm ask --collection <id> --q "..." \\
  [--topK 8] \\
  [--dbPath .data/vectorstore.sqlite] \\
  [--model llama3.1:8b] \\
  [--maxChunks 6] \\
  [--maxPerFile 2] \\
  [--minChars 120] \\
  [--maxCharsPerChunk 1600] \\
  [--keepStatus] \\
  [--mmr] \\
  [--mmrLambda 0.75] \\
  [--k 6] \\
  [--minSim 0.55] \\
  [--intentDebug] \\
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
  useMmr,
  mmrLambda,
  k,
  minSim,
});

const store = new SqliteStore(dbPath);
store.init();

// 1) embed query
console.log("[ask] embedding query...");
const [qVec] = await embed([q]);
if (!qVec) throw new Error("Query embedding failed (no vector returned).");

// 2) retrieve with routed-first
console.log("[ask] retrieving topK (intent routing routed-first + backfill)...");
const retrievalTopK = Math.max(topK, 16);

const { plan, results: retrievedRaw } = retrieveWithRouting({
  store,
  collection,
  query: q,
  queryVector: qVec,
  topK: retrievalTopK,
  includeVectors: useMmr,
});

// ✅ If debug, always print intent plan (even without --intentDebug)
if (intentDebug || debug) {
  console.log("[ask] intent plan", { intent: plan.intent, prefixes: plan.prefixes });
}

console.log("[ask] retrieved", retrievedRaw.length, "chunks");

// ✅ candidate pool aligned with eval.ts
const candidatePoolSize = Math.max(retrievalTopK, maxChunks * 4);

let candidatesForSelection: RetrievedChunk[] = [];

if (useMmr) {
  const pool = (retrievedRaw as RetrievedChunkWithVector[]).filter((c) => c.similarity >= minSim);
  console.log("[ask] mmr pool size", pool.length, "minSim", minSim);

  // pick a larger diversified list, then let selection do its job
  const mmrK = Math.max(candidatePoolSize, k);
  const mmrChosen = mmrSelect(pool, mmrK, mmrLambda) as unknown as RetrievedChunkWithVector[];

  candidatesForSelection = (mmrChosen.length > 0 ? mmrChosen : (retrievedRaw as RetrievedChunkWithVector[]))
    .slice(0, candidatePoolSize)
    .map((x) => x as unknown as RetrievedChunk);
} else {
  candidatesForSelection = (retrievedRaw as RetrievedChunk[]).slice(0, candidatePoolSize);
}

// 3) assemble context with priority keep + priority boost
let assembled = assembleContextFromCandidates(candidatesForSelection, {
  maxChunks,
  maxPerFile,
  maxCharsPerChunk,
  minChars,
  dropStatus,
  priorityPrefixes: plan.prefixes,
});

if (assembled.selected.length === 0) {
  assembled = assembleContextFromCandidates(candidatesForSelection, {
    maxChunks,
    maxPerFile,
    maxCharsPerChunk,
    minChars: Math.min(minChars, 60),
    dropStatus: false,
    priorityPrefixes: plan.prefixes,
  });

  if (assembled.selected.length === 0) {
    const fallbackChosen = candidatesForSelection.slice(0, maxChunks);
    const context = fallbackChosen
      .map((r, i) => {
        const src = formatSource(r);
        const text = truncateText(r.chunk.text, maxCharsPerChunk);
        return `### [S${i + 1}] ${src}\nSimilarity: ${r.similarity.toFixed(4)}\n\n${text}\n`;
      })
      .join("\n");
    assembled = { context, selected: fallbackChosen };
  }
}

const { context, selected } = assembled;

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
const answer = await generateWithOllama({ model, system, prompt });

console.log("\n=== ANSWER ===\n");
console.log(answer.trim());

console.log("\n=== SOURCES USED ===\n");
selected.forEach((r, i) => {
  console.log(`[S${i + 1}] ${formatSource(r)} (similarity=${r.similarity.toFixed(4)})`);
});

console.log("\n[ask] done ✅");
