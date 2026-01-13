import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { RawDocument, SourceType, CollectionId } from "@rag/core";
import { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES } from "./ignore.js";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function inferSourceType(filePath: string): SourceType | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "markdown";
  if (ext === ".txt") return "text";
  return null;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
      await walk(path.join(dir, ent.name), root, out);
    } else if (ent.isFile()) {
      if (DEFAULT_IGNORE_FILES.has(ent.name)) continue;
      out.push(path.join(dir, ent.name));
    }
  }
}

export async function loadRepoDocuments(params: {
  repoPath: string;
  collection: CollectionId;
}): Promise<RawDocument[]> {
  const repoPath = path.resolve(params.repoPath);
  const files: string[] = [];
  await walk(repoPath, repoPath, files);

  const docs: RawDocument[] = [];
  for (const absPath of files) {
    const sourceType = inferSourceType(absPath);
    if (!sourceType) continue;

    const content = await fs.readFile(absPath, "utf8");
    const relPath = path.relative(repoPath, absPath).replaceAll("\\", "/");

    // doc id stable: collection + relPath
    const id = sha256(`${params.collection}:${relPath}`);

    docs.push({
      id,
      collection: params.collection,
      path: relPath,
      sourceType,
      content,
    });
  }

  return docs;
}
