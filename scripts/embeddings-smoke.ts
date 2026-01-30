import { embed } from "@rag/embeddings";

console.log("[smoke] start");

try {
  const texts = [
    "Authentication flow using JWT middleware",
    "How to run migrations in Prisma",
  ];

  console.log("[smoke] embedding", texts.length, "texts...");

  const vectors = await embed(texts);

  console.log("[smoke] done");
  console.log("count:", vectors.length);
  console.log("dim:", vectors[0]?.length);
  console.log("first 5 numbers:", vectors[0]?.slice(0, 5));
} catch (err) {
  console.error("[smoke] error:", err);
  process.exitCode = 1;
}
