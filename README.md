# RAG Repo Assistant — DocVault

A local, evaluation-driven Retrieval-Augmented Generation (RAG) assistant designed to answer questions strictly from a codebase and its documentation, with explicit source citations and measurable retrieval quality.

This project is intentionally not a toy demo. It focuses on retrieval correctness, ranking, and failure analysis rather than prompt engineering.

---

## 🎯 Project Goal

Build a local RAG assistant capable of:

- Indexing a repository (code + documentation)
- Retrieving the most relevant source passages
- Answering only from retrieved context
- Always citing sources
- Being objectively evaluable (e.g. hit@k metrics)

The system is designed as a mini semantic search engine suitable for backend / AI engineering portfolios.

---

## 🧠 Key Principles

- Retrieval quality > generation quality  
- Deterministic behavior where possible  
- Explicit heuristics over hidden magic  
- Measurable improvements via evaluation  
- Understanding why the system fails is as important as making it work  

---

## 🏗️ Architecture Overview

### 1. Vector Store (SQLite)

- Custom vector store built on SQLite (better-sqlite3)
- Stores:
  - chunk text
  - metadata (source path, section path, type, etc.)
  - embedding vectors
- Cosine similarity search
- Local storage (.data/vectorstore.sqlite)

Key file:  
packages/vectorstore/src/sqliteStore.ts

---

### 2. Ingestion & Embeddings

- Repository files are chunked and embedded
- Rich metadata is attached to each chunk:
  - sourcePath
  - sectionPath
  - sourceType
- Embeddings generated via @rag/embeddings

---

### 3. Query Pipeline (ask.ts)

Query  
→ Embedding  
→ Intent Routing (tests / auth / migrations / openapi / db / general)  
→ Routed-first Retrieval + Global Backfill  
→ Candidate Pool Expansion  
→ Selection Heuristics  
→ (optional) MMR  
→ LLM Answer (with citations)

Selection heuristics include:
- minimum content length
- per-file chunk limits
- section de-duplication
- priority preservation for routed sources

---

### 4. Intent Routing

Before final selection, queries are classified into coarse intents such as:

- migrations  
- auth  
- tests  
- openapi  
- db  
- general  

Each intent biases retrieval toward specific parts of the repository (e.g. ADRs for migrations).

Important: This routing is deliberately simple and explainable.  
It reflects real-world search systems where deterministic routing is often preferred over opaque ML classifiers for critical queries.

---

### 5. Evaluation (eval.ts)

The system includes an automated evaluation pipeline.

- Dataset: eval/docvault.jsonl
- Metrics:
  - hit@1
  - hit@3
  - hit@5
  - hit@8
- Each query defines a mustContain source path
- Supports:
  - intent routing
  - debug output for failure analysis

Current results (DocVault dataset):

hit@1: 100%  
hit@3: 100%  
hit@5: 100%  
hit@8: 100%  

This validates that the system reliably retrieves the correct source for targeted technical questions.

---

## 🔍 MMR (Maximum Marginal Relevance)

MMR is implemented as an optional selection stage.

- It balances:
  - relevance to the query
  - diversity among selected chunks
- Useful for:
  - broad or multi-topic queries
  - reducing redundancy in large candidate sets

In practice, strong routing + selection heuristics already reduce redundancy significantly.  
MMR is therefore treated as an optional optimization rather than a default requirement.

---

## 📌 Key Learnings & Limitations

### Documentation Quality Matters More Than Expected

One of the most important findings of this project is that retrieval quality is heavily constrained by documentation structure.

For example:
- Boilerplate framework READMEs (e.g. create-next-app) introduce semantic noise.
- High-level queries like “How is the API designed?” perform poorly if no explicit design-oriented documentation exists.

While routing and heuristics can mitigate these issues, the most effective solution is better documentation and information architecture, not more ranking rules.

This mirrors real-world enterprise systems, where search quality depends as much on content hygiene as on embeddings or ranking algorithms.

---

### This Is Not a “Universal RAG”

This project intentionally focuses on:
- correctness
- explainability
- evaluation

It does not attempt to:
- generalize across arbitrary corpora
- auto-classify documents with ML models
- hide heuristics behind opaque abstractions

Those are valid next steps, but out of scope for the core objective.

---

## 🚀 Possible Future Improvements

- Document classification at ingestion time (doc type, domain, quality)
- Declarative routing configuration (YAML/JSON instead of code)
- Additional metrics (MRR, precision@k)
- Multi-repository support
- Content hygiene tooling (boilerplate detection)

---

## 🧩 Why This Project Exists

This project demonstrates:
- practical understanding of RAG beyond embeddings
- search and retrieval engineering fundamentals
- evaluation-driven iteration
- the ability to reason about system failures, not just successes

It is intentionally designed as a backend / AI engineering portfolio piece, not a demo chatbot.

---

## 🛠️ Commands

pnpm ask --collection docvault --q "How are database migrations handled?"  

pnpm ask --collection docvault --q "How does authentication work?" --debug  

pnpm eval  

pnpm eval --debugMisses  

---

## 📎 Notes

- All data is local  
- No external APIs required  
- .data/ is gitignored by design  

