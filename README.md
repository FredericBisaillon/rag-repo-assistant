# RAG Repo Assistant

Production-minded RAG system to index and query multiple code repositories using offline indexing + governed online retrieval.

## Monorepo
- `apps/api` — query API
- `packages/ingestion` — offline ingestion + chunking
- `packages/vectorstore` — vector store abstraction
- `packages/evals` — retrieval evals

## Scripts
- `pnpm build`
- `pnpm typecheck`
