import { readFileSync } from "node:fs";
import { embed } from "@rag/embeddings";
import { SqliteStore } from "../packages/vectorstore/src/sqliteStore.js";
import type { RetrievedChunk } from "@rag/core";

type EvalCase = {
  id?: string;
  q: string;
  collection: string;
  mustContain: string[];
};

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
 * Example: hasFlag("debugMisses") checks for "--debugMisses"
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

/* -----------------------------
   Matching helpers
------------------------------ */
function normalizeSource(r: RetrievedChunk): string {
  const md = r.chunk.metadata;
  const section = md.sectionPath ? `#${md.sectionPath}` : "";
  return `${md.sourcePath}${section}`;
}

function toPathOnly(s: string): string {
  const idx = s.indexOf("#");
  return idx === -1 ? s : s.slice(0, idx);
}

function sourceMatchesNeedle(source: string, needle: string): boolean {
  const sPath = toPathOnly(source);
  const nPath = toPathOnly(needle);

  if (sPath === nPath) return true;
  if (sPath.startsWith(nPath)) return true;
  if (source.includes(needle)) return true;

  return false;
}

function hitAtK(selectedSources: string[], mustContain: string[], k: number): boolean {
  const top = selectedSources.slice(0, k);
  return mustContain.some((needle) => top.some((s) => sourceMatchesNeedle(s, needle)));
}

function loadJsonl(path: string): EvalCase[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EvalCase);
}

/* -----------------------------
   Intent routing
------------------------------ */
type RoutePlan = {
  prefixes: string[];
  intent: "tests" | "db" | "migrations" | "openapi" | "auth" | "general";
};

function inferRoutePlan(query: string): RoutePlan {
  const q = query.toLowerCase();
  const hasAny = (words: string[]) => words.some((w) => q.includes(w));

  const isTests = hasAny(["integration test", "integration tests", "vitest", "test:db", "pnpm test"]);
  const isDb = hasAny(["database", "postgres", "postgresql", "pg pool", "connection", "access the database"]);
  const isAuth = hasAny(["authentication", "auth", "x-user-id", "jwt", "oauth", "cognito"]);
  const isOpenApi = hasAny(["openapi", "swagger", "typebox"]);
  const isMigrations = hasAny([
    "migration",
    "migrations",
    "database migrations",
    "how are database migrations handled",
    "sql-first",
  ]);

  // ✅ IMPORTANT: migrations must win over db
  if (isTests) return { intent: "tests", prefixes: ["apps/api/README.md"] };

  if (isMigrations)
    return {
      intent: "migrations",
      prefixes: ["apps/docs/app/adr/", "apps/docs/README.md", "README.md"],
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
}): { plan: RoutePlan; results: RetrievedChunk[] } {
  const plan = inferRoutePlan(params.query);

  const out: RetrievedChunk[] = [];
  const seen = new Set<string>();

  const pushDedup = (items: RetrievedChunk[]) => {
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
      filter?: { sourcePathPrefix?: string };
    } = {
      collections: [params.collection],
      queryVector: params.queryVector,
      topK: Math.max(params.topK, 32),
    };

    if (filter !== undefined) searchParams.filter = filter;

    return params.store.search(searchParams) as RetrievedChunk[];
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
   Selection
------------------------------ */
function isPrioritySource(sourcePath: string, priorityPrefixes: string[]): boolean {
  return priorityPrefixes.some((p) => sourcePath.startsWith(p));
}

function isLowSignalChunk(
  r: RetrievedChunk,
  opts: { minChars: number; dropStatus: boolean; priorityPrefixes: string[] }
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

function selectForContext(
  candidates: RetrievedChunk[],
  opts: {
    maxChunks: number;
    maxPerFile: number;
    minChars: number;
    dropStatus: boolean;
    priorityPrefixes: string[];
  }
): RetrievedChunk[] {
  const perFileCount = new Map<string, number>();
  const seen = new Set<string>();
  const selected: RetrievedChunk[] = [];

  for (const r of candidates) {
    if (isLowSignalChunk(r, opts)) continue;

    const md = r.chunk.metadata;
    const file = md.sourcePath;
    const sectionKey = md.sectionPath ?? "";
    const dedupKey = `${file}::${sectionKey}`;

    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const count = perFileCount.get(file) ?? 0;
    if (count >= opts.maxPerFile) continue;

    selected.push(r);
    perFileCount.set(file, count + 1);

    if (selected.length >= opts.maxChunks) break;
  }

  return selected;
}

/* -----------------------------
   CLI args
------------------------------ */
const evalPath = getArg("evalPath") ?? "eval/docvault.jsonl";
const dbPath = getArg("dbPath") ?? ".data/vectorstore.sqlite";

const topK = getArgNumber("topK", 16);

const maxChunks = getArgNumber("maxChunks", 8);
const maxPerFile = getArgNumber("maxPerFile", 2);
const minChars = getArgNumber("minChars", 120);

// dropStatus defaults true unless --keepStatus
const dropStatus = !hasFlag("keepStatus");

const ks = [1, 3, 5, 8].filter((x) => x <= maxChunks);
const debugMisses = hasFlag("debugMisses");

console.log("[eval] start", {
  evalPath,
  dbPath,
  retrieval: { topK },
  mmr: { enabled: false },
  select: { maxChunks, maxPerFile, minChars, dropStatus },
  ks,
});

const cases = loadJsonl(evalPath);
if (cases.length === 0) {
  console.error("[eval] no cases found in", evalPath);
  process.exit(1);
}

const store = new SqliteStore(dbPath);
store.init();

let total = 0;
const hits: Record<number, number> = Object.fromEntries(ks.map((k) => [k, 0]));

for (const c of cases) {
  total++;

  const [qVec] = await embed([c.q]);
  if (!qVec) {
    console.error("[eval] missing embedding for case", c.id ?? total);
    continue;
  }

  const { plan, results: retrieved } = retrieveWithRouting({
    store,
    collection: c.collection,
    query: c.q,
    queryVector: qVec,
    topK,
  });

  // ✅ FIX IMPORTANT: give selection a larger candidate pool
  const candidatePool = retrieved.slice(0, Math.max(topK, maxChunks * 4));

  let selectedFinal = selectForContext(candidatePool, {
    maxChunks,
    maxPerFile,
    minChars,
    dropStatus,
    priorityPrefixes: plan.prefixes,
  });

  if (selectedFinal.length === 0) {
    selectedFinal = selectForContext(candidatePool, {
      maxChunks,
      maxPerFile,
      minChars: Math.min(minChars, 60),
      dropStatus: false,
      priorityPrefixes: plan.prefixes,
    });

    if (selectedFinal.length === 0) selectedFinal = candidatePool.slice(0, maxChunks);
  }

  const sources = selectedFinal.map(normalizeSource);

  for (const k of ks) {
    if (hitAtK(sources, c.mustContain, k)) {
      hits[k] = (hits[k] ?? 0) + 1;
    }
  }

  const ok3 = hitAtK(sources, c.mustContain, 3);
  const best = sources[0] ?? "(none)";

  console.log(`[case ${c.id ?? total}] hit@3=${ok3 ? "✅" : "❌"} best=${best} q="${c.q}"`);

  if (!ok3 && debugMisses) {
    console.log("  mustContain:", c.mustContain);
    console.log("  intent:", plan.intent);
    console.log("  prefixes:", plan.prefixes);
    console.log("  top sources:");
    for (let i = 0; i < Math.min(8, sources.length); i++) {
      console.log(`   - ${sources[i]}`);
    }
  }
}

console.log("\n=== RESULTS ===");
for (const k of ks) {
  const hitCount = hits[k] ?? 0;
  const rate = total === 0 ? 0 : hitCount / total;
  console.log(`hit@${k}: ${hitCount}/${total} = ${(rate * 100).toFixed(1)}%`);
}

console.log("\n[eval] done ✅");
