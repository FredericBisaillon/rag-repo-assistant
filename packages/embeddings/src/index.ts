import { ollamaEmbedOne } from "./ollama.js";

const DEFAULT_MODEL = "nomic-embed-text:latest";

export async function embed(
  texts: string[],
  opts?: { model?: string }
): Promise<number[][]> {
  const model = opts?.model ?? DEFAULT_MODEL;

  if (!Array.isArray(texts) || texts.length === 0) return [];

  for (const t of texts) {
    if (typeof t !== "string") throw new Error("embed() expects string[]");
  }

  const vectors: number[][] = [];
  for (const text of texts) {
    const v = await ollamaEmbedOne({ model, text });
    vectors.push(v);
  }

  const dim = vectors[0]?.length ?? 0;
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(
        `Inconsistent embedding dimension: expected ${dim}, got ${v.length}`
      );
    }
  }

  return vectors;
}
