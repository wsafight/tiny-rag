import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_VECTOR_STORE, VECTOR_STORE_SCHEMA_VERSION } from '../constants/index';
import { fail, hasValidEmbedding, invariant } from '../utils/index';
import type { EmbeddingConfig } from '../providers/types';
import type { KeywordStats, StoreMeta, TermCounts } from './types';

interface VectorStoreLine {
  _meta?: Partial<StoreMeta>;
  id?: unknown;
  source?: unknown;
  chunkIndex?: unknown;
  heading?: unknown;
  content?: unknown;
  hash?: unknown;
  embedding?: unknown;
  keywordHeadingTerms?: unknown;
  keywordHeadingTokenCount?: unknown;
  keywordContentTerms?: unknown;
  keywordContentTokenCount?: unknown;
}

export interface VectorStoreRecord extends KeywordStats {
  id: string;
  source: string;
  chunkIndex: number;
  heading: string;
  content: string;
  embedding: number[];
  hash?: string;
}

export interface LoadedVectorStoreRecord extends Omit<VectorStoreRecord, 'embedding'> {
  embedding: Float32Array;
}

export interface LoadedVectorStore {
  meta: StoreMeta;
  records: LoadedVectorStoreRecord[];
}

export interface StreamVectorStoreOptions {
  vectorStore?: string;
  embeddingDim?: number;
  onWarning?: (message: string) => void;
  onMeta?: (meta: StoreMeta) => void;
}

export interface LoadVectorStoreOptions {
  vectorStore?: string;
  onWarning?: (message: string) => void;
}

interface VectorStoreTextLine {
  line: string;
  lineNumber: number;
}

async function canAccessVectorStore(vectorStore: string): Promise<boolean> {
  try {
    await fs.access(vectorStore);
    return true;
  } catch {
    return false;
  }
}

async function ensureVectorStoreExists(vectorStore: string): Promise<void> {
  if (!(await canAccessVectorStore(vectorStore))) {
    fail(`未找到向量库: ${vectorStore}，请先生成向量库`);
  }
}

async function* readVectorStoreTextLines(
  vectorStore: string,
): AsyncGenerator<VectorStoreTextLine> {
  await ensureVectorStoreExists(vectorStore);

  const stream = createReadStream(vectorStore, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      lineNumber += 1;
      yield { line, lineNumber };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function parseVectorStoreLine(line: string, message: string): VectorStoreLine {
  try {
    return JSON.parse(line) as VectorStoreLine;
  } catch {
    fail(message);
  }
}

function tryParseVectorStoreLine(line: string): VectorStoreLine | undefined {
  try {
    return JSON.parse(line) as VectorStoreLine;
  } catch {
    return undefined;
  }
}

function isTermCounts(value: unknown): value is TermCounts {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1]),
    )
  );
}

function readKeywordStats(obj: VectorStoreLine): KeywordStats {
  return {
    keywordHeadingTerms: isTermCounts(obj.keywordHeadingTerms)
      ? obj.keywordHeadingTerms
      : undefined,
    keywordHeadingTokenCount:
      typeof obj.keywordHeadingTokenCount === 'number' &&
      Number.isFinite(obj.keywordHeadingTokenCount)
        ? obj.keywordHeadingTokenCount
        : undefined,
    keywordContentTerms: isTermCounts(obj.keywordContentTerms)
      ? obj.keywordContentTerms
      : undefined,
    keywordContentTokenCount:
      typeof obj.keywordContentTokenCount === 'number' &&
      Number.isFinite(obj.keywordContentTokenCount)
        ? obj.keywordContentTokenCount
        : undefined,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

export function validateVectorStoreMeta(
  meta: Partial<StoreMeta>,
  embConfig: EmbeddingConfig,
  embeddingDim?: number,
): asserts meta is StoreMeta {
  invariant(
    !isPositiveInteger(meta.version),
    '向量库 version 缺失或非法，请重新生成向量库',
  );
  invariant(
    meta.version !== VECTOR_STORE_SCHEMA_VERSION,
    `向量库 version=${meta.version} 与当前期望 ${VECTOR_STORE_SCHEMA_VERSION} 不一致，请重新生成向量库`,
  );
  invariant(
    typeof meta.provider !== 'string' || meta.provider.trim() === '',
    '向量库 provider 缺失或非法，请重新生成向量库',
  );
  invariant(
    meta.provider !== embConfig.provider,
    `向量库 provider=${meta.provider} 与当前 ${embConfig.provider} 不一致，请重新生成向量库`,
  );
  invariant(
    typeof meta.model !== 'string' || meta.model.trim() === '',
    '向量库 model 缺失或非法，请重新生成向量库',
  );
  invariant(
    meta.model !== embConfig.model,
    `向量库 model=${meta.model} 与当前 ${embConfig.model} 不一致，请重新生成向量库`,
  );
  invariant(!isPositiveInteger(meta.dim), '向量库 dim 缺失或非法，请重新生成向量库');
  invariant(
    embeddingDim !== undefined && meta.dim !== embeddingDim,
    `向量库 dim=${meta.dim} 与当前向量 dim=${embeddingDim} 不一致，请重新生成向量库`,
  );
  const chunkSize = meta.chunkSize;
  const chunkOverlap = meta.chunkOverlap;
  if (!isPositiveInteger(chunkSize)) {
    fail('向量库 chunkSize 缺失或非法，请重新生成向量库');
  }
  if (!isNonNegativeInteger(chunkOverlap)) {
    fail('向量库 chunkOverlap 缺失或非法，请重新生成向量库');
  }
  invariant(
    chunkOverlap >= chunkSize,
    `向量库 chunkOverlap=${chunkOverlap} 必须小于 chunkSize=${chunkSize}，请重新生成向量库`,
  );
  invariant(
    meta.headingWeight !== undefined && !isNonNegativeFiniteNumber(meta.headingWeight),
    '向量库 headingWeight 非法，请重新生成向量库',
  );
  invariant(!isValidIsoDate(meta.createdAt), '向量库 createdAt 缺失或非法，请重新生成向量库');
}

export async function readVectorStoreMeta(
  embConfig: EmbeddingConfig,
  vectorStore = DEFAULT_VECTOR_STORE,
): Promise<StoreMeta> {
  for await (const { line } of readVectorStoreTextLines(vectorStore)) {
    const obj = parseVectorStoreLine(line, '向量库首行损坏，请重新生成向量库');
    const meta = obj._meta;
    if (!meta) {
      fail('向量库缺少 _meta 元数据，文件格式不正确，请重新生成向量库');
    }
    validateVectorStoreMeta(meta, embConfig);
    return meta;
  }

  return fail('向量库为空，请重新生成向量库');
}

export async function* streamVectorStoreRecords(
  embConfig: EmbeddingConfig,
  options: StreamVectorStoreOptions,
): AsyncGenerator<VectorStoreRecord> {
  const vectorStore = options.vectorStore ?? DEFAULT_VECTOR_STORE;
  let metaSeen = false;
  let expectedDim = options.embeddingDim;
  for await (const { line, lineNumber } of readVectorStoreTextLines(vectorStore)) {
    const obj = tryParseVectorStoreLine(line);
    if (!obj) {
      options.onWarning?.(`跳过无法解析的第 ${lineNumber} 行`);
      if (!metaSeen) {
        metaSeen = true;
        fail('向量库首行损坏，请重新生成向量库');
      }
      continue;
    }

    if (!metaSeen) {
      metaSeen = true;
      const meta = obj._meta;
      if (!meta) {
        fail('向量库缺少 _meta 元数据，文件格式不正确（应为 NDJSON），请重新生成向量库');
      }
      validateVectorStoreMeta(meta, embConfig, options.embeddingDim);
      expectedDim = options.embeddingDim ?? meta.dim;
      options.onMeta?.(meta);
      continue;
    }

    if (!hasValidEmbedding(obj.embedding, expectedDim)) {
      options.onWarning?.(`跳过非法或维度不一致的 embedding: ${obj.id ?? 'unknown'}`);
      continue;
    }
    if (
      typeof obj.id !== 'string' ||
      typeof obj.source !== 'string' ||
      typeof obj.chunkIndex !== 'number' ||
      typeof obj.content !== 'string'
    ) {
      options.onWarning?.(`跳过字段不完整的记录: ${obj.id ?? 'unknown'}`);
      continue;
    }

    yield {
      id: obj.id,
      source: obj.source,
      chunkIndex: obj.chunkIndex,
      heading: typeof obj.heading === 'string' ? obj.heading : '',
      content: obj.content,
      embedding: obj.embedding,
      hash: typeof obj.hash === 'string' ? obj.hash : undefined,
      ...readKeywordStats(obj),
    };
  }

  if (!metaSeen) {
    fail('向量库为空，请重新生成向量库');
  }
}

export async function loadVectorStore(
  embConfig: EmbeddingConfig,
  options: LoadVectorStoreOptions = {},
): Promise<LoadedVectorStore> {
  let meta: StoreMeta | undefined;
  const records: LoadedVectorStoreRecord[] = [];

  for await (const record of streamVectorStoreRecords(embConfig, {
    vectorStore: options.vectorStore,
    onWarning: options.onWarning,
    onMeta: (value) => {
      meta = value;
    },
  })) {
    records.push({
      ...record,
      embedding: Float32Array.from(record.embedding),
    });
  }

  if (meta === undefined) {
    fail('向量库缺少 _meta 元数据，文件格式不正确，请重新生成向量库');
  }
  return { meta, records };
}

export async function readEmbeddingCache(
  config: EmbeddingConfig,
  vectorStore = DEFAULT_VECTOR_STORE,
): Promise<Map<string, number[]>> {
  if (!(await canAccessVectorStore(vectorStore))) {
    return new Map();
  }

  const cache = new Map<string, number[]>();
  let metaSeen = false;
  for await (const { line } of readVectorStoreTextLines(vectorStore)) {
    const obj = tryParseVectorStoreLine(line);
    if (!obj) {
      if (!metaSeen) {
        metaSeen = true;
        return new Map();
      }
      continue;
    }
    if (!metaSeen) {
      metaSeen = true;
      const meta = obj._meta;
      if (
        !meta ||
        meta.version !== VECTOR_STORE_SCHEMA_VERSION ||
        meta.provider !== config.provider ||
        meta.model !== config.model
      ) {
        return new Map();
      }
      continue;
    }
    if (typeof obj.hash === 'string' && hasValidEmbedding(obj.embedding)) {
      cache.set(obj.hash, obj.embedding);
    }
  }
  return cache;
}

export async function writeVectorStore(
  meta: StoreMeta,
  records: readonly object[],
  vectorStore = DEFAULT_VECTOR_STORE,
): Promise<void> {
  await fs.mkdir(path.dirname(vectorStore), { recursive: true });
  const tmp = `${vectorStore}.${randomUUID()}.tmp`;
  const out = createWriteStream(tmp, { encoding: 'utf-8' });

  const writeLine = async (line: string): Promise<void> => {
    if (!out.write(`${line}\n`)) await once(out, 'drain');
  };

  try {
    await writeLine(JSON.stringify({ _meta: meta }));
    for (const record of records) await writeLine(JSON.stringify(record));
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await fs.rename(tmp, vectorStore);
}
