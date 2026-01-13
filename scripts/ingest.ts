import { ingestRepo } from "@rag/ingestion";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const repoPath = getArg("repo");
const collection = getArg("collection");

if (!repoPath || !collection) {
  console.error("Usage: pnpm ingest --repo <path> --collection <id>");
  process.exit(1);
}

const result = await ingestRepo({ repoPath, collection });
console.log({
  documents: result.documents.length,
  chunks: result.chunks.length,
  sampleChunk: result.chunks[0],
});
