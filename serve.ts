#!/usr/bin/env node

import 'dotenv/config';
import http from 'node:http';
import {
  DEFAULT_VECTOR_STORE,
} from './src/constants/index';
import {
  createChat,
  createEmbedder,
  type ProviderRuntimeOptions,
} from './src/providers/index';
import {
  createRetriever,
  DEFAULT_KEYWORD_HEADING_WEIGHT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_MIN_SCORE,
  DEFAULT_PER_SOURCE_LIMIT,
  DEFAULT_QUERY_VECTOR_STORE,
  DEFAULT_TOP_K,
} from './src/query/index';
import { query } from './src/query/index';
import {
  envChoice as readEnvChoice,
  envInteger as readEnvInteger,
  envNumber as readEnvNumber,
  envString as readEnvString,
} from './runtime/env';
import { fail, invariant } from './src/utils/index';
import type { EnvNumberOptions, EnvSource } from './runtime/env';
import type {
  EmbeddingConfig,
  LLMConfig,
  PromptOptions,
  QueryResult,
  SearchOptions,
  VectorStoreRetriever,
} from './src/types';

const ENV = process.env as EnvSource;

function envString(key: string, fallback = ''): string {
  return readEnvString(ENV, key, fallback);
}

function envChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  return readEnvChoice(ENV, key, choices, fallback);
}

function envNumber(
  key: string,
  fallback: number,
  opts: EnvNumberOptions = {},
): number {
  return readEnvNumber(ENV, key, fallback, opts);
}

function envInteger(
  key: string,
  fallback: number,
  opts: EnvNumberOptions = {},
): number {
  return readEnvInteger(ENV, key, fallback, opts);
}

function getLLMConfig(): LLMConfig {
  const provider = envChoice('LLM_PROVIDER', ['lmstudio', 'ollama', 'openai', 'deepseek'], 'lmstudio');
  switch (provider) {
    case 'lmstudio':
      return {
        provider,
        baseURL: envString('LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234/v1'),
        apiKey: envString('LMSTUDIO_API_KEY', 'lm-studio'),
        model: envString('LMSTUDIO_LLM_MODEL', 'qwen2.5-7b-instruct'),
      };
    case 'ollama':
      return {
        provider,
        baseURL: envString('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
        apiKey: '',
        model: envString('OLLAMA_LLM_MODEL', 'qwen2.5:7b'),
      };
    case 'openai':
      return {
        provider,
        baseURL: envString('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        apiKey: envString('OPENAI_API_KEY'),
        model: envString('OPENAI_LLM_MODEL', 'gpt-4o-mini'),
      };
    case 'deepseek':
      return {
        provider,
        baseURL: envString('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
        apiKey: envString('DEEPSEEK_API_KEY'),
        model: envString('DEEPSEEK_LLM_MODEL', 'deepseek-v4-pro'),
      };
  }
}

function getEmbeddingConfig(): EmbeddingConfig {
  const provider = envChoice('EMBEDDING_PROVIDER', ['lmstudio', 'ollama', 'openai'], 'lmstudio');
  switch (provider) {
    case 'lmstudio':
      return {
        provider,
        baseURL: envString('LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234/v1'),
        apiKey: envString('LMSTUDIO_API_KEY', 'lm-studio'),
        model: envString('LMSTUDIO_EMBEDDING_MODEL', 'text-embedding-nomic-embed-text-v1.5'),
      };
    case 'ollama':
      return {
        provider,
        baseURL: envString('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
        apiKey: '',
        model: envString('OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text'),
      };
    case 'openai':
      return {
        provider,
        baseURL: envString('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        apiKey: envString('OPENAI_API_KEY'),
        model: envString('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
      };
  }
}

function getProviderRuntimeOptions(): ProviderRuntimeOptions {
  return {
    requestTimeoutMs: envInteger('REQUEST_TIMEOUT_MS', 60_000, { min: 1 }),
    requestRetries: envInteger('REQUEST_RETRIES', 2, { min: 0 }),
    ollamaEmbedConcurrency: envInteger('OLLAMA_EMBED_CONCURRENCY', 4, { min: 1 }),
    llmTemperature: envNumber('LLM_TEMPERATURE', 0.2, { min: 0, max: 2 }),
  };
}

function getSearchDefaults(): Required<Pick<
  SearchOptions,
  'vectorStore' | 'topK' | 'minScore' | 'perSourceLimit' | 'keywordWeight' | 'keywordHeadingWeight'
>> &
  Pick<SearchOptions, 'intermediateDir'> {
  return {
    vectorStore: envString('VECTOR_STORE', DEFAULT_QUERY_VECTOR_STORE),
    intermediateDir: envString('INTERMEDIATE_DIR') || undefined,
    topK: envInteger('TOP_K', DEFAULT_TOP_K, { min: 1 }),
    minScore: envNumber('MIN_SCORE', DEFAULT_MIN_SCORE, { min: -1, max: 1 }),
    perSourceLimit: envInteger('PER_SOURCE_LIMIT', DEFAULT_PER_SOURCE_LIMIT, { min: 1 }),
    keywordWeight: envNumber('KEYWORD_WEIGHT', DEFAULT_KEYWORD_WEIGHT, { min: 0, max: 1 }),
    keywordHeadingWeight: envNumber('KEYWORD_HEADING_WEIGHT', DEFAULT_KEYWORD_HEADING_WEIGHT, {
      min: 0,
    }),
  };
}

interface QueryRequestBody extends Partial<SearchOptions> {
  question?: unknown;
  prompt?: PromptOptions;
  includeCandidates?: unknown;
  includeContext?: unknown;
}

const llmConfig = getLLMConfig();
const embeddingConfig = getEmbeddingConfig();
const runtimeOptions = getProviderRuntimeOptions();
const searchDefaults = getSearchDefaults();
const embed = createEmbedder(embeddingConfig, runtimeOptions);
const chat = createChat(llmConfig, runtimeOptions);

let retriever: VectorStoreRetriever;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 1024 * 1024;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    invariant(total > limit, '请求体超过 1MB');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

function pickRequestSearchOptions(body: QueryRequestBody): SearchOptions {
  return {
    ...searchDefaults,
    topK: typeof body.topK === 'number' ? body.topK : searchDefaults.topK,
    minScore: typeof body.minScore === 'number' ? body.minScore : searchDefaults.minScore,
    perSourceLimit:
      typeof body.perSourceLimit === 'number'
        ? body.perSourceLimit
        : searchDefaults.perSourceLimit,
    keywordWeight:
      typeof body.keywordWeight === 'number' ? body.keywordWeight : searchDefaults.keywordWeight,
    keywordHeadingWeight:
      typeof body.keywordHeadingWeight === 'number'
        ? body.keywordHeadingWeight
        : searchDefaults.keywordHeadingWeight,
  };
}

function serializeResult(result: QueryResult): object {
  return {
    question: result.question,
    answer: result.answer,
    hits: result.hits,
    ...(result.candidates ? { candidates: result.candidates } : {}),
    ...(result.context !== undefined ? { context: result.context } : {}),
    embeddingElapsedMs: result.embeddingElapsedMs,
    searchElapsedMs: result.searchElapsedMs,
    retrievalElapsedMs: result.retrievalElapsedMs,
    ...(result.generationElapsedMs !== undefined
      ? { generationElapsedMs: result.generationElapsedMs }
      : {}),
    noAnswerReason: result.noAnswerReason,
    meta: result.meta,
  };
}

async function reloadRetriever(): Promise<VectorStoreRetriever> {
  retriever = await createRetriever(embeddingConfig, {
    ...searchDefaults,
    onWarning: (message) => console.warn(`[serve] ${message}`),
  });
  return retriever;
}

async function handleQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as QueryRequestBody;
  if (typeof body.question !== 'string' || body.question.trim() === '') {
    fail('question 必须是非空字符串');
  }
  const question = body.question;

  const result = await query(question, {
    ...pickRequestSearchOptions(body),
    embeddingConfig,
    llmConfig,
    embed,
    chat,
    retriever,
    prompt: body.prompt,
    includeCandidates: body.includeCandidates === true,
    includeContext: body.includeContext === true,
    stream: false,
    onWarning: (message) => console.warn(`[serve] ${message}`),
  });
  json(res, 200, serializeResult(result));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        vectorStore: searchDefaults.vectorStore || DEFAULT_VECTOR_STORE,
        records: retriever.recordCount,
        embedding: `${embeddingConfig.provider}/${embeddingConfig.model}`,
        llm: `${llmConfig.provider}/${llmConfig.model}`,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/query') {
      await handleQuery(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      const loaded = await reloadRetriever();
      json(res, 200, { ok: true, records: loaded.recordCount, meta: loaded.meta });
      return;
    }
    json(res, 404, {
      error: 'not_found',
      endpoints: ['GET /health', 'POST /query', 'POST /reload'],
    });
  } catch (err) {
    json(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const host = envString('SERVE_HOST', '127.0.0.1');
const port = envInteger('SERVE_PORT', 8787, { min: 1, max: 65535 });

await reloadRetriever();

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(port, host, () => {
  console.log(`[serve] listening on http://${host}:${port}`);
  console.log(`[serve] loaded ${retriever.recordCount} records from ${searchDefaults.vectorStore}`);
});
