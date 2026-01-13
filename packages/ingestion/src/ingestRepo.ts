import type { Chunk, RawDocument } from "@rag/core";
import { loadRepoDocuments } from "./repoLoader.js";
import { chunkMarkdownDocument } from "./markdownChunker.js";
import { chunkTextDocument } from "./textChunker.js";

export async function ingestRepo(params: {
  repoPath: string;
  collection: string;
}): Promise<{ documents: RawDocument[]; chunks: Chunk[] }> {
  const documents = await loadRepoDocuments({
    repoPath: params.repoPath,
    collection: params.collection,
  });

  const chunks: Chunk[] = [];
  for (const doc of documents) {
    if (doc.sourceType === "markdown") chunks.push(...chunkMarkdownDocument(doc));
    if (doc.sourceType === "text") chunks.push(...chunkTextDocument(doc));
  }

  return { documents, chunks };
}
