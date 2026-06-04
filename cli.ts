#!/usr/bin/env node
// cli.ts
// -----------------------------------------------------------------------------
// Tiny RAG command line entry point.
// CLI 负责环境变量、stdin/stdout 和进程退出；src/ 只保留可复用库函数。
// -----------------------------------------------------------------------------

import 'dotenv/config';
import readline from 'node:readline';
import {
  DEFAULT_DOCUMENT_EXTENSIONS,
  DEFAULT_DOCUMENTS_DIR,
  DEFAULT_VECTOR_STORE,
} from './src/constants/index';
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_HEADING_WEIGHT,
  DEFAULT_INGEST_CONCURRENCY,
  ingest,
} from './src/ingestion/index';
import { createRetriever, query } from './src/query/index';
import {
  DEFAULT_KEYWORD_HEADING_WEIGHT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_MIN_SCORE,
  DEFAULT_PER_SOURCE_LIMIT,
  DEFAULT_QUERY_VECTOR_STORE,
  DEFAULT_TOP_K,
} from './src/query/retrieval';
import { createChat, createEmbedder, type ProviderRuntimeOptions } from './src/providers/index';
import {
  envBoolean as readEnvBoolean,
  envChoice as readEnvChoice,
  envInteger as readEnvInteger,
  envNumber as readEnvNumber,
  envString as readEnvString,
} from './runtime/env';
import type { EnvNumberOptions, EnvSource } from './runtime/env';
import type { EmbeddingConfig, IngestProgressEvent, LLMConfig, SearchHit } from './src/types';

const [command, ...args] = process.argv.slice(2);
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

function envBoolean(key: string, fallback: boolean): boolean {
  return readEnvBoolean(ENV, key, fallback);
}

function printUsage(): void {
  console.log(`Usage:
  tiny-rag ingest
  tiny-rag query "你的问题"

Development:
  pnpm ingest
  pnpm query -- "你的问题"`);
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

async function readQuestion(queryArgs: readonly string[]): Promise<string> {
  const argQuestion = queryArgs.join(' ').trim();
  if (argQuestion) return argQuestion;

  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const lines: string[] = [];
    for await (const line of rl) lines.push(line);
    return lines.join('\n').trim();
  }

  console.log('直接输入问题，回车提交（Ctrl+C 退出）；也可以用：pnpm query -- "你的问题"');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('请输入问题: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const USE_COLOR = process.stdout.isTTY && envString('NO_COLOR', '') === '';

function color(code: string, text: string): string {
  return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function bold(text: string): string {
  return color('1', text);
}

function dim(text: string): string {
  return color('2', text);
}

function label(text: string): string {
  return dim(text.padEnd(10));
}

function pad(text: string | number, width: number): string {
  return String(text).padEnd(width);
}

function truncate(text: unknown, max: number): string {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

function envList(key: string, fallback: readonly string[]): string[] {
  return envString(key, fallback.join(','))
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function printSection(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim('-'.repeat(title.length)));
}

function printQueryHeader(
  question: string,
  llmConfig: LLMConfig,
  embeddingConfig: EmbeddingConfig,
): void {
  console.log('');
  console.log(bold('Tiny RAG Query'));
  console.log(`${label('Question')} ${question}`);
  console.log(`${label('LLM')} ${llmConfig.provider}/${llmConfig.model}`);
  console.log(`${label('Embedding')} ${embeddingConfig.provider}/${embeddingConfig.model}`);
}

function printHits(hits: readonly SearchHit[], minScore: number): void {
  if (hits.length === 0) {
    printSection('Retrieved Context');
    console.log(`  没有片段达到 MIN_SCORE=${minScore}，可降低阈值或补充资料后重新 ingest`);
    return;
  }

  printSection(`Retrieved Context (top ${hits.length})`);
  const idxWidth = Math.max(1, String(hits.length).length);
  const chunkWidth = Math.max(5, ...hits.map((h) => String(h.chunkIndex).length));
  const sourceWidth = Math.min(
    42,
    Math.max('source'.length, ...hits.map((h) => String(h.source ?? '').length)),
  );

  console.log(
    `  ${pad('#', idxWidth)}  ${pad('score', 6)}  ${pad('chunk', chunkWidth)}  ${pad(
      'source',
      sourceWidth,
    )}  heading`,
  );
  console.log(
    dim(
      `  ${'-'.repeat(idxWidth)}  ${'-'.repeat(6)}  ${'-'.repeat(chunkWidth)}  ${'-'.repeat(
        sourceWidth,
      )}  ${'-'.repeat(7)}`,
    ),
  );

  hits.forEach((hit, idx) => {
    console.log(
      `  ${pad(idx + 1, idxWidth)}  ${hit.score.toFixed(4)}  ${pad(
        hit.chunkIndex,
        chunkWidth,
      )}  ${pad(truncate(hit.source, sourceWidth), sourceWidth)}  ${hit.heading || '-'}`,
    );
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function printRetrievalTime(timing: {
  embeddingElapsedMs: number;
  searchElapsedMs: number;
  retrievalElapsedMs: number;
}): void {
  console.log(
    `${label('Retrieval')} ${formatDuration(timing.retrievalElapsedMs)} ` +
      `(embedding ${formatDuration(timing.embeddingElapsedMs)}, search ${formatDuration(
        timing.searchElapsedMs,
      )})`,
  );
}

function printIngestProgress(event: IngestProgressEvent): void {
  switch (event.type) {
    case 'loaded-docs':
      console.log(`[ingest] 共加载 ${event.docsCount} 个文档`);
      return;
    case 'built-chunks':
      console.log(
        `[ingest] 切块数量: ${event.chunksCount} (size=${event.chunkSize}, overlap=${event.chunkOverlap})`,
      );
      return;
    case 'cache':
      console.log(
        `[ingest] 缓存命中 ${event.cachedCount} / ${event.total}，待向量化 ${event.pendingCount}`,
      );
      return;
    case 'embedded':
      console.log(`[ingest] 已向量化 ${event.done} / ${event.total}`);
      return;
    case 'written':
      console.log(
        `[ingest] 向量库已写入 ${event.vectorStore} (dim=${event.dim}, version=${event.version}, lines=${event.lines})`,
      );
  }
}

async function runIngest(): Promise<void> {
  const embeddingConfig = getEmbeddingConfig();
  const runtimeOptions = getProviderRuntimeOptions();
  const documentsDir = envString('DOCUMENTS_DIR', DEFAULT_DOCUMENTS_DIR);
  const documentExtensions = envList('DOCUMENT_EXTENSIONS', DEFAULT_DOCUMENT_EXTENSIONS);
  console.log(
    `[ingest] embedding provider: ${embeddingConfig.provider} model: ${embeddingConfig.model}`,
  );

  const result = await ingest({
    documentsDir,
    vectorStore: envString('VECTOR_STORE', DEFAULT_VECTOR_STORE),
    intermediateDir: envString('INTERMEDIATE_DIR'),
    documentExtensions,
    sourceRoot: envString('SOURCE_ROOT', documentsDir),
    chunkSize: envInteger('CHUNK_SIZE', DEFAULT_CHUNK_SIZE, { min: 1 }),
    chunkOverlap: envInteger('CHUNK_OVERLAP', DEFAULT_CHUNK_OVERLAP, { min: 0 }),
    headingWeight: envNumber('HEADING_WEIGHT', DEFAULT_HEADING_WEIGHT, { min: 0 }),
    embedBatchSize: envInteger('EMBED_BATCH_SIZE', DEFAULT_EMBED_BATCH_SIZE, { min: 1 }),
    concurrency: envInteger('INGEST_CONCURRENCY', DEFAULT_INGEST_CONCURRENCY, { min: 1 }),
    embeddingConfig,
    embed: createEmbedder(embeddingConfig, runtimeOptions),
    onProgress: printIngestProgress,
  });

  if (result.skippedReason === 'no-docs') {
    console.warn(
      `[ingest] 未在 ${result.documentsDir} 找到 ${documentExtensions.join(' / ')} 文档`,
    );
  } else if (result.skippedReason === 'no-chunks') {
    console.warn(`[ingest] ${result.documentsDir} 中没有可导入的非空内容`);
  } else if (result.skippedReason === 'unchanged') {
    console.log(`[ingest] 内容未变化，跳过重写 ${result.vectorStore}`);
  }
}

async function runQuery(queryArgs: readonly string[]): Promise<void> {
  const question = await readQuestion(queryArgs);
  if (!question) {
    console.error('[query] 未输入问题');
    process.exitCode = 1;
    return;
  }

  const llmConfig = getLLMConfig();
  const embeddingConfig = getEmbeddingConfig();
  const runtimeOptions = getProviderRuntimeOptions();
  const minScore = envNumber('MIN_SCORE', DEFAULT_MIN_SCORE, { min: -1, max: 1 });
  const vectorStore = envString('VECTOR_STORE', DEFAULT_QUERY_VECTOR_STORE);
  const intermediateDir = envString('INTERMEDIATE_DIR');
  const topK = envInteger('TOP_K', DEFAULT_TOP_K, { min: 1 });
  const perSourceLimit = envInteger('PER_SOURCE_LIMIT', DEFAULT_PER_SOURCE_LIMIT, { min: 1 });
  const keywordWeight = envNumber('KEYWORD_WEIGHT', DEFAULT_KEYWORD_WEIGHT, { min: 0, max: 1 });
  const keywordHeadingWeight = envNumber('KEYWORD_HEADING_WEIGHT', DEFAULT_KEYWORD_HEADING_WEIGHT, {
    min: 0,
  });
  const stream = envBoolean('STREAM', true);
  const embed = createEmbedder(embeddingConfig, runtimeOptions);
  const chat = createChat(llmConfig, runtimeOptions);
  const onWarning = (message: string) => console.warn(message);
  const searchOptions = {
    vectorStore,
    intermediateDir,
    topK,
    minScore,
    perSourceLimit,
    keywordWeight,
    keywordHeadingWeight,
    onWarning,
  };

  printQueryHeader(question, llmConfig, embeddingConfig);
  const retriever = await createRetriever(embeddingConfig, searchOptions);

  if (stream) {
    const result = await query(question, {
      ...searchOptions,
      embeddingConfig,
      llmConfig,
      embed,
      chat,
      retriever,
      stream: true,
      onRetrieved: ({ hits, embeddingElapsedMs, searchElapsedMs, retrievalElapsedMs }) => {
        printHits(hits, minScore);
        printRetrievalTime({ embeddingElapsedMs, searchElapsedMs, retrievalElapsedMs });
        if (hits.length > 0) {
          printSection('Answer');
          process.stdout.write('\n');
        }
      },
      onToken: (token) => process.stdout.write(token),
    });

    if (result.noAnswerReason) {
      printSection('Answer');
      console.log(result.answer);
    } else {
      process.stdout.write('\n');
    }
    return;
  }

  const result = await query(question, {
    ...searchOptions,
    embeddingConfig,
    llmConfig,
    embed,
    chat,
    retriever,
    stream: false,
    onRetrieved: ({ hits, embeddingElapsedMs, searchElapsedMs, retrievalElapsedMs }) => {
      printHits(hits, minScore);
      printRetrievalTime({ embeddingElapsedMs, searchElapsedMs, retrievalElapsedMs });
    },
  });

  printSection('Answer');
  console.log(result.answer);
}

async function run(): Promise<void> {
  switch (command) {
    case 'ingest':
      await runIngest();
      return;
    case 'query':
      await runQuery(args);
      return;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      printUsage();
      return;
    default:
      console.error(`[cli] 未知命令: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(`[${command || 'cli'}] 失败:`, err);
  process.exit(1);
});
