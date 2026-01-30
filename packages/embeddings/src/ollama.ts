type OllamaEmbeddingResponse = {
  embedding: number[];
};

function getOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
}

function normalizeModelName(model: string): string {
  return model.trim();
}

export async function ollamaEmbedOne(args: {
  model: string;
  text: string;
}): Promise<number[]> {
  const { model, text } = args;

  const baseUrl = getOllamaBaseUrl();
  const safeModel = normalizeModelName(model);

  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: safeModel,
      prompt: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Ollama embeddings request failed: ${res.status} ${res.statusText}\n${body}`
    );
  }

  const data = (await res.json()) as OllamaEmbeddingResponse;

  if (!data?.embedding || !Array.isArray(data.embedding)) {
    throw new Error("Ollama embeddings response missing `embedding` array.");
  }

  return data.embedding;
}
