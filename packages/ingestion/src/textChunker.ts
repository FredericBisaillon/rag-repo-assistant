import crypto from "node:crypto";
import type { Chunk, ChunkMetadata, RawDocument } from "@rag/core";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function chunkBySize(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const out: string[] = [];
  for (let i = 0; i < trimmed.length; i += maxChars) {
    out.push(trimmed.slice(i, i + maxChars));
  }
  return out;
}

export function chunkTextDocument(doc: RawDocument, opts?: { maxChars?: number }): Chunk[] {
  const maxChars = opts?.maxChars ?? 3000;

  const parts = chunkBySize(doc.content, maxChars);
  return parts.map((text, i) => {
    const contentHash = sha256(text);
    const metadata: ChunkMetadata = {
      collection: doc.collection,
      sourcePath: doc.path,
      sourceType: doc.sourceType,
      sectionPath: "Document",
      contentHash,
    };
    const id = sha256(`${doc.collection}:${doc.path}:${i}:${contentHash}`);
    return { id, text, metadata };
  });
}
