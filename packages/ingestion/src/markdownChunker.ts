import crypto from "node:crypto";
import type { Chunk, ChunkMetadata, RawDocument } from "@rag/core";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

type MdSection = {
  sectionPath: string; // "Title > Sub"
  text: string;
};

function splitMarkdownByHeaders(md: string): MdSection[] {
  const lines = md.split(/\r?\n/);
  const sections: MdSection[] = [];

  const headerStack: { level: number; title: string }[] = [];
  let buf: string[] = [];

  function currentPath(): string {
    if (headerStack.length === 0) return "Document";
    return headerStack.map((h) => h.title).join(" > ");
  }

  function flush() {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    sections.push({ sectionPath: currentPath(), text });
  }

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      const title = m[2]!;

      while (headerStack.length > 0 && headerStack[headerStack.length - 1]!.level >= level) {
        headerStack.pop();
      }
      headerStack.push({ level, title });
    } else {
      buf.push(line);
    }
  }
  flush();

  return sections;
}

function chunkTextBySize(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);

  let current = "";
  for (const p of paragraphs) {
    const piece = p.trim();
    if (!piece) continue;

    if ((current + "\n\n" + piece).trim().length <= maxChars) {
      current = (current ? current + "\n\n" : "") + piece;
      continue;
    }

    if (current) chunks.push(current);
    if (piece.length <= maxChars) {
      current = piece;
    } else {
      // fallback: hard split
      for (let i = 0; i < piece.length; i += maxChars) {
        chunks.push(piece.slice(i, i + maxChars));
      }
      current = "";
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export function chunkMarkdownDocument(doc: RawDocument, opts?: { maxChars?: number }): Chunk[] {
  const maxChars = opts?.maxChars ?? 3000;

  const sections = splitMarkdownByHeaders(doc.content);
  const out: Chunk[] = [];

  for (const sec of sections) {
    const parts = chunkTextBySize(sec.text, maxChars);
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i]!.trim();
      const contentHash = sha256(text);

      const metadata: ChunkMetadata = {
        collection: doc.collection,
        sourcePath: doc.path,
        sourceType: doc.sourceType,
        sectionPath: sec.sectionPath,
        contentHash,
      };

      const id = sha256(`${doc.collection}:${doc.path}:${sec.sectionPath}:${i}:${contentHash}`);

      out.push({ id, text, metadata });
    }
  }

  return out;
}
