# Tiny RAG

> A lightweight TypeScript RAG kernel: ingest local Markdown / text documents into a vector store, then run retrieval-augmented Q&A via **CLI, an HTTP service, or the library API**.

[中文文档](./README.zh-CN.md)

Core pipeline:

```text
documents → chunk → embedding → vector-store.ndjson → retrieval → LLM answer
```

## Quick Start

```bash
pnpm install
cp .env.example .env          # defaults to a local LM Studio
# put your knowledge-base files into ./documents (.md / .txt)
pnpm ingest                   # build the vector store vector-store.ndjson
pnpm query -- "How do I cancel an order?"
```

> The default config assumes LM Studio is running locally. To switch to Ollama / OpenAI / DeepSeek, see [Requirements](#requirements) and `.env.example`.

## Capabilities

- **Document ingestion**: recursively read local `.md` / `.txt`, chunk by Markdown headings and paragraphs (custom chunkers supported).
- **Multiple providers**: LM Studio, Ollama, and OpenAI-compatible APIs can all generate embeddings.
- **Zero database**: the vector store is a local NDJSON file.
- **Hybrid retrieval**: vector similarity fused with keyword/BM25.
- **Two entry points**: the CLI for quick debugging, or `serve.ts` as a long-running service that reuses the in-memory index.
- **Reusable library**: `src/` is library code; `cli.ts` / `serve.ts` are local entry points and are not published to `dist`.

## Requirements

- Node.js `>=20.19.0`
- An embedding service
- A chat completion service

The default config uses LM Studio:

```text
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LLM_PROVIDER=lmstudio
EMBEDDING_PROVIDER=lmstudio
```

You can also switch to Ollama / OpenAI / DeepSeek; see `.env.example`.

## Installation

```bash
pnpm install
cp .env.example .env
```

Put your knowledge-base files into the default directory `./documents` (`.md` / `.txt`, configurable via `DOCUMENT_EXTENSIONS`).

## Build the Vector Store

```bash
pnpm ingest    # read DOCUMENTS_DIR, write VECTOR_STORE
```

The generated `vector-store.ndjson` is the local vector store: the first line is metadata, and each following line is one chunk record. **Re-run `pnpm ingest` after you change your source documents.**

## CLI Query

```bash
pnpm query -- "How do I cancel an order?"
```

The CLI is good for local debugging; for real service usage, start the [HTTP Service](#http-service).

## HTTP Service

```bash
pnpm serve     # listens on http://127.0.0.1:8787 by default
```

Three endpoints: `GET /health`, `POST /query`, `POST /reload`.

**Health check** (returns record count, configured vector store, and the active embedding/LLM models)

```bash
curl -s http://127.0.0.1:8787/health
```

**Query**

```bash
curl -s http://127.0.0.1:8787/query \
  -H 'content-type: application/json' \
  -d '{"question":"How do I cancel an order?"}'
```

The response includes `answer`, `hits`, timing metrics, and vector-store metadata by default. To inspect the full candidate set or context, add `includeCandidates` / `includeContext`:

```bash
curl -s http://127.0.0.1:8787/query \
  -H 'content-type: application/json' \
  -d '{"question":"How do I cancel an order?","includeCandidates":true,"includeContext":true}'
```

Per-request overrides for `topK`, `minScore`, `perSourceLimit`, `keywordWeight`, and `prompt` are accepted in the body and fall back to the env defaults.

**Reload the vector store** (no restart needed after re-ingesting)

```bash
curl -s -X POST http://127.0.0.1:8787/reload
```

**Auth and limits**

- `/query` and `/reload` are unauthenticated by default. Set `SERVE_AUTH_TOKEN` to require `Authorization: Bearer <token>` on those endpoints — do this before exposing the service beyond localhost.
- `SERVE_MAX_CONCURRENCY` (default `4`) caps in-flight `/query` requests; excess requests get `503`.
- Request bodies over `1MB` get `413`; invalid JSON gets `400`.

## Library API

`src/` provides a reusable API. Callers pass embedding/chat functions explicitly; the library code does not read environment variables, print, or exit the process.

```ts
import {
  createChat,
  createEmbedder,
  createRetriever,
  query,
  type EmbeddingConfig,
  type LLMConfig,
} from './src/index';

const embeddingConfig: EmbeddingConfig = {
  provider: 'lmstudio',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'text-embedding-nomic-embed-text-v1.5',
};

const llmConfig: LLMConfig = {
  provider: 'lmstudio',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'qwen2.5-7b-instruct',
};

const embed = createEmbedder(embeddingConfig);
const chat = createChat(llmConfig);
const retriever = await createRetriever(embeddingConfig, {
  vectorStore: './vector-store.ndjson',
});

const result = await query('How do I cancel an order?', {
  embeddingConfig,
  llmConfig,
  embed,
  chat,
  retriever,
  topK: 4,
  perSourceLimit: 2,
});

console.log(result.answer);
```

## Common Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DOCUMENTS_DIR` | `./documents` | Directory of documents to ingest |
| `SOURCE_ROOT` | `./documents` | Base path for the relative `source` field |
| `DOCUMENT_EXTENSIONS` | `.md,.txt` | Extensions to ingest |
| `VECTOR_STORE` | `./vector-store.ndjson` | Local vector-store file |
| `INTERMEDIATE_DIR` | empty | Optional intermediate cache dir; speeds up vector-store loading when set, disabled when empty |
| `CHUNK_SIZE` | `600` | Target length of a single chunk |
| `CHUNK_OVERLAP` | `80` | Overlap length when hard-splitting long text |
| `TOP_K` | `4` | Number of final returned chunks |
| `PER_SOURCE_LIMIT` | `2` | Max chunks per source allowed into the final context |
| `MIN_SCORE` | `0` | Minimum score threshold; `0` disables filtering |
| `KEYWORD_WEIGHT` | `0.3` | keyword/BM25 fusion weight |
| `STREAM` | `1` | CLI streaming output: `1` prints tokens as generated, `0` waits for the full answer |
| `EMBED_BATCH_SIZE` | `32` | Embedding requests per batch during ingest |
| `INGEST_CONCURRENCY` | `1` | Concurrent embedding batches during ingest (raise to `2-4` for OpenAI-style services) |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout in milliseconds |
| `REQUEST_RETRIES` | `2` | Retry count on request failure (excludes the first attempt) |
| `OLLAMA_EMBED_CONCURRENCY` | `4` | Ollama embedding concurrency (OpenAI / LM Studio batch instead) |
| `LLM_TEMPERATURE` | `0.2` | LLM sampling temperature |
| `LLM_PROVIDER` | `lmstudio` | Chat provider: `lmstudio` / `ollama` / `openai` / `deepseek` |
| `EMBEDDING_PROVIDER` | `lmstudio` | Embedding provider: `lmstudio` / `ollama` / `openai` |
| `SERVE_HOST` | `127.0.0.1` | HTTP service bind address |
| `SERVE_PORT` | `8787` | HTTP service port |
| `SERVE_AUTH_TOKEN` | empty | When set, `/query` and `/reload` require `Authorization: Bearer <token>` |
| `SERVE_MAX_CONCURRENCY` | `4` | Max in-flight `/query` requests; excess returns `503` |

## Project Structure

```text
src/
  constants/    Default constants
  ingestion/    Document reading, chunking, ingest into the vector store
  providers/    LM Studio / Ollama / OpenAI-compatible providers
  query/        Retrieval, prompt construction, Q&A entry point
  storage/      Local NDJSON vector-store read/write
  utils/        Shared utilities
runtime/        Environment-variable parsing used by CLI / serve
cli.ts          Local CLI debugging entry point
serve.ts        HTTP service entry point
test/           Node test runner tests
```

## Suitable Scale

Good for individuals, local debugging, small-team internal knowledge bases, and customer-support assist Q&A. Team size is not a hard limit — what actually drives scale is the **number of chunks, concurrent query volume, model-service throughput, and whether production-grade protections are in place**.

Use the ranges below as a guide:

| Scenario | Fit | Notes |
| --- | --- | --- |
| Individual / local debugging | ✅ Suitable | Either the CLI or HTTP service works |
| Small internal knowledge base | ✅ Suitable | About `100 - 1000` docs, `1 - 20 MB` plain text |
| Customer-support pilot | ✅ Suitable | ~`10` people can use it directly; low-frequency Q&A is usually `1 - 3` concurrent |
| Larger internal team | ⚠️ Extensible | `20 - 50` people at low concurrency is fine, but add auth, logging, rate limiting, and error codes first |
| High concurrency / public service | ❌ Not recommended as-is | Needs queues, monitoring, auditing, access control, and stability work |
| Large knowledge base | 🔧 Upgrade the retrieval layer | At 100k+ chunks, use a vector database or ANN index |

**Comfort zone**: `2,000 - 30,000` chunks. Within this range retrieval is usually not the bottleneck; more often the bottleneck is the response speed and concurrency of the embedding / LLM service.

**Optimization priority** (example: ~`10`-person low-concurrency support, no need to rewrite in Go): run as a service → add auth and rate limiting → add request logging → control model concurrency → add a vector database only when needed.

## Build and Test

```bash
pnpm typecheck       # type check
pnpm test            # Node test runner tests
pnpm bench           # performance benchmark
pnpm build           # build the library entry into dist/
```

The build output contains only the library entry:

```text
dist/index.js
dist/index.cjs
dist/src/**/*.d.ts
```

`cli.ts` and `serve.ts` are for local use only and are not published as package entry points.
