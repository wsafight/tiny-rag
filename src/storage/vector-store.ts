import { promises as fs, createReadStream, type Dirent } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { DEFAULT_VECTOR_STORE, VECTOR_STORE_SCHEMA_VERSION } from '../constants/index';
import { fail, hasValidEmbedding, invariant, sha1Hex, tryParseJson } from '../utils/index';
import { readJsonLines, writeFileAtomic, writeJsonLinesAtomic } from './json-lines';
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
  embeddingOffset: number;
}

export interface LoadedVectorStore {
  meta: StoreMeta;
  records: LoadedVectorStoreRecord[];
  embeddings: Float32Array;
}

export interface StreamVectorStoreOptions {
  vectorStore?: string;
  embeddingDim?: number;
  onWarning?: (message: string) => void;
  onMeta?: (meta: StoreMeta) => void;
}

export interface LoadVectorStoreOptions {
  vectorStore?: string;
  intermediateDir?: string;
  onWarning?: (message: string) => void;
}

export interface WriteVectorStoreOptions {
  intermediateDir?: string;
}

interface VectorStoreTextLine {
  line: string;
  lineNumber: number;
}

interface VectorStoreCacheManifest {
  version: 1;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  meta: StoreMeta;
  recordCount: number;
  dim: number;
  recordsFile: string;
  embeddingsFile: string;
}

interface VectorStoreCachePaths {
  manifest: string;
  records: string;
  embeddings: string;
}

const INTERMEDIATE_CACHE_FILE_RE =
  /^[a-f0-9]{16}\.(?:manifest\.json|records\.ndjson|embeddings\.f32)(?:\.[^.]+\.tmp)?$/;

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
    fail(`vector store not found: ${vectorStore}, please generate it first`);
  }
}

function resolveIntermediateDir(intermediateDir?: string): string | undefined {
  const trimmed = intermediateDir?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function getVectorStoreCachePaths(vectorStore: string, intermediateDir: string): VectorStoreCachePaths {
  const sourcePath = path.resolve(vectorStore);
  const key = sha1Hex(sourcePath).slice(0, 16);
  return {
    manifest: path.join(intermediateDir, `${key}.manifest.json`),
    records: path.join(intermediateDir, `${key}.records.ndjson`),
    embeddings: path.join(intermediateDir, `${key}.embeddings.f32`),
  };
}

export async function clearIntermediateCache(intermediateDir?: string): Promise<void> {
  const dir = resolveIntermediateDir(intermediateDir);
  if (!dir) return;

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !INTERMEDIATE_CACHE_FILE_RE.test(entry.name)) return;
      await fs.rm(path.join(dir, entry.name), { force: true });
    }),
  );
}

function readLoadedRecord(value: unknown): LoadedVectorStoreRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as VectorStoreLine & { embeddingOffset?: unknown };
  if (
    typeof obj.id !== 'string' ||
    typeof obj.source !== 'string' ||
    typeof obj.chunkIndex !== 'number' ||
    typeof obj.content !== 'string' ||
    typeof obj.embeddingOffset !== 'number' ||
    !Number.isInteger(obj.embeddingOffset) ||
    obj.embeddingOffset < 0
  ) {
    return undefined;
  }
  return {
    id: obj.id,
    source: obj.source,
    chunkIndex: obj.chunkIndex,
    heading: typeof obj.heading === 'string' ? obj.heading : '',
    content: obj.content,
    hash: typeof obj.hash === 'string' ? obj.hash : undefined,
    embeddingOffset: obj.embeddingOffset,
    ...readKeywordStats(obj),
  };
}

function toCacheRecord(
  value: object,
  embeddingOffset: number,
): LoadedVectorStoreRecord | undefined {
  return readLoadedRecord({ ...value, embeddingOffset });
}

function* vectorStoreJsonLines(
  meta: StoreMeta,
  records: readonly object[],
): Generator<unknown> {
  yield { _meta: meta };
  yield* records;
}

async function readLoadedCacheRecords(file: string): Promise<LoadedVectorStoreRecord[]> {
  const records: LoadedVectorStoreRecord[] = [];
  for await (const { lineNumber, value } of readJsonLines(file)) {
    try {
      const record = readLoadedRecord(value);
      if (!record) fail(`intermediate records line ${lineNumber} has incomplete fields`);
      records.push(record);
    } catch {
      fail(`intermediate records line ${lineNumber} is corrupted, please delete the intermediate directory and retry`);
    }
  }
  return records;
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
  return tryParseJson(line) as VectorStoreLine | undefined;
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
    'vector store version is missing or invalid, please regenerate the vector store',
  );
  invariant(
    meta.version !== VECTOR_STORE_SCHEMA_VERSION,
    `vector store version=${meta.version} does not match the expected ${VECTOR_STORE_SCHEMA_VERSION}, please regenerate the vector store`,
  );
  invariant(
    typeof meta.provider !== 'string' || meta.provider.trim() === '',
    'vector store provider is missing or invalid, please regenerate the vector store',
  );
  invariant(
    meta.provider !== embConfig.provider,
    `vector store provider=${meta.provider} does not match the current ${embConfig.provider}, please regenerate the vector store`,
  );
  invariant(
    typeof meta.model !== 'string' || meta.model.trim() === '',
    'vector store model is missing or invalid, please regenerate the vector store',
  );
  invariant(
    meta.model !== embConfig.model,
    `vector store model=${meta.model} does not match the current ${embConfig.model}, please regenerate the vector store`,
  );
  invariant(!isPositiveInteger(meta.dim), 'vector store dim is missing or invalid, please regenerate the vector store');
  invariant(
    embeddingDim !== undefined && meta.dim !== embeddingDim,
    `vector store dim=${meta.dim} does not match the current vector dim=${embeddingDim}, please regenerate the vector store`,
  );
  const chunkSize = meta.chunkSize;
  const chunkOverlap = meta.chunkOverlap;
  if (!isPositiveInteger(chunkSize)) {
    fail('vector store chunkSize is missing or invalid, please regenerate the vector store');
  }
  if (!isNonNegativeInteger(chunkOverlap)) {
    fail('vector store chunkOverlap is missing or invalid, please regenerate the vector store');
  }
  invariant(
    chunkOverlap >= chunkSize,
    `vector store chunkOverlap=${chunkOverlap} must be less than chunkSize=${chunkSize}, please regenerate the vector store`,
  );
  invariant(
    meta.headingWeight !== undefined && !isNonNegativeFiniteNumber(meta.headingWeight),
    'vector store headingWeight is invalid, please regenerate the vector store',
  );
  invariant(!isValidIsoDate(meta.createdAt), 'vector store createdAt is missing or invalid, please regenerate the vector store');
}

export async function readVectorStoreMeta(
  embConfig: EmbeddingConfig,
  vectorStore = DEFAULT_VECTOR_STORE,
): Promise<StoreMeta> {
  for await (const { line } of readVectorStoreTextLines(vectorStore)) {
    const obj = parseVectorStoreLine(line, 'vector store first line is corrupted, please regenerate the vector store');
    const meta = obj._meta;
    if (!meta) {
      fail('vector store is missing _meta metadata, the file format is incorrect, please regenerate the vector store');
    }
    validateVectorStoreMeta(meta, embConfig);
    return meta;
  }

  return fail('vector store is empty, please regenerate the vector store');
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
      options.onWarning?.(`skipping unparseable line ${lineNumber}`);
      if (!metaSeen) {
        metaSeen = true;
        fail('vector store first line is corrupted, please regenerate the vector store');
      }
      continue;
    }

    if (!metaSeen) {
      metaSeen = true;
      const meta = obj._meta;
      if (!meta) {
        fail('vector store is missing _meta metadata, the file format is incorrect (should be NDJSON), please regenerate the vector store');
      }
      validateVectorStoreMeta(meta, embConfig, options.embeddingDim);
      expectedDim = options.embeddingDim ?? meta.dim;
      options.onMeta?.(meta);
      continue;
    }

    if (!hasValidEmbedding(obj.embedding, expectedDim)) {
      options.onWarning?.(`skipping invalid or dim-mismatched embedding: ${obj.id ?? 'unknown'}`);
      continue;
    }
    if (
      typeof obj.id !== 'string' ||
      typeof obj.source !== 'string' ||
      typeof obj.chunkIndex !== 'number' ||
      typeof obj.content !== 'string'
    ) {
      options.onWarning?.(`skipping record with incomplete fields: ${obj.id ?? 'unknown'}`);
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
    fail('vector store is empty, please regenerate the vector store');
  }
}

async function tryLoadVectorStoreCache(
  embConfig: EmbeddingConfig,
  vectorStore: string,
  intermediateDir: string,
): Promise<LoadedVectorStore | undefined> {
  const paths = getVectorStoreCachePaths(vectorStore, intermediateDir);
  const sourcePath = path.resolve(vectorStore);
  const sourceStat = await fs.stat(sourcePath);

  let manifest: VectorStoreCacheManifest;
  try {
    manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf-8')) as VectorStoreCacheManifest;
  } catch {
    return undefined;
  }

  if (
    manifest.version !== 1 ||
    manifest.sourcePath !== sourcePath ||
    manifest.sourceSize !== sourceStat.size ||
    manifest.sourceMtimeMs !== sourceStat.mtimeMs ||
    manifest.recordsFile !== path.basename(paths.records) ||
    manifest.embeddingsFile !== path.basename(paths.embeddings)
  ) {
    return undefined;
  }
  validateVectorStoreMeta(manifest.meta, embConfig, manifest.dim);

  const records = await readLoadedCacheRecords(paths.records);

  const bytes = await fs.readFile(paths.embeddings);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    fail('intermediate embeddings byte length is invalid, please delete the intermediate directory and retry');
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const embeddings = new Float32Array(buffer);
  invariant(
    records.length !== manifest.recordCount ||
      embeddings.length !== manifest.recordCount * manifest.dim,
    'intermediate vector matrix is inconsistent with the manifest, please delete the intermediate directory and retry',
  );

  return { meta: manifest.meta, records, embeddings };
}

async function writeLoadedVectorStoreCache(
  store: LoadedVectorStore,
  vectorStore: string,
  intermediateDir: string,
): Promise<void> {
  const paths = getVectorStoreCachePaths(vectorStore, intermediateDir);
  const sourcePath = path.resolve(vectorStore);
  const sourceStat = await fs.stat(sourcePath);
  await fs.mkdir(intermediateDir, { recursive: true });

  await writeJsonLinesAtomic(paths.records, store.records);
  await writeFileAtomic(
    paths.embeddings,
    new Uint8Array(
      store.embeddings.buffer,
      store.embeddings.byteOffset,
      store.embeddings.byteLength,
    ),
  );

  const manifest: VectorStoreCacheManifest = {
    version: 1,
    sourcePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    meta: store.meta,
    recordCount: store.records.length,
    dim: store.meta.dim,
    recordsFile: path.basename(paths.records),
    embeddingsFile: path.basename(paths.embeddings),
  };
  await writeFileAtomic(paths.manifest, JSON.stringify(manifest, null, 2));
}

async function writeVectorStoreCacheFromRecords(
  meta: StoreMeta,
  records: readonly object[],
  vectorStore: string,
  intermediateDir: string,
): Promise<void> {
  const loadedRecords: LoadedVectorStoreRecord[] = [];
  const embeddings = new Float32Array(records.length * meta.dim);
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as VectorStoreLine;
    if (!hasValidEmbedding(record.embedding, meta.dim)) return;
    const loadedRecord = toCacheRecord(record, i * meta.dim);
    if (!loadedRecord) return;
    loadedRecords.push(loadedRecord);
    embeddings.set(record.embedding, i * meta.dim);
  }
  await writeLoadedVectorStoreCache(
    { meta, records: loadedRecords, embeddings },
    vectorStore,
    intermediateDir,
  );
}

export async function loadVectorStore(
  embConfig: EmbeddingConfig,
  options: LoadVectorStoreOptions = {},
): Promise<LoadedVectorStore> {
  const intermediateDir = resolveIntermediateDir(options.intermediateDir);
  const vectorStore = options.vectorStore ?? DEFAULT_VECTOR_STORE;
  if (intermediateDir) {
    const cached = await tryLoadVectorStoreCache(embConfig, vectorStore, intermediateDir).catch(
      (err) => {
        options.onWarning?.(
          `[intermediate] intermediate cache unavailable, falling back to NDJSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      },
    );
    if (cached) return cached;
  }

  let meta: StoreMeta | undefined;
  const records: LoadedVectorStoreRecord[] = [];
  const vectors: number[][] = [];

  for await (const record of streamVectorStoreRecords(embConfig, {
    vectorStore,
    onWarning: options.onWarning,
    onMeta: (value) => {
      meta = value;
    },
  })) {
    const { embedding, ...rest } = record;
    records.push({
      ...rest,
      embeddingOffset: vectors.length * record.embedding.length,
    });
    vectors.push(embedding);
  }

  if (meta === undefined) {
    fail('vector store is missing _meta metadata, the file format is incorrect, please regenerate the vector store');
  }
  const embeddings = new Float32Array(records.length * meta.dim);
  for (let i = 0; i < vectors.length; i++) {
    embeddings.set(vectors[i], i * meta.dim);
    records[i].embeddingOffset = i * meta.dim;
  }
  const store = { meta, records, embeddings };
  if (intermediateDir) {
    await writeLoadedVectorStoreCache(store, vectorStore, intermediateDir).catch((err) => {
      options.onWarning?.(
        `[intermediate] failed to write intermediate cache: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  return store;
}

export async function readEmbeddingCache(
  config: EmbeddingConfig,
  vectorStore = DEFAULT_VECTOR_STORE,
  intermediateDir?: string,
): Promise<Map<string, number[]>> {
  if (!(await canAccessVectorStore(vectorStore))) {
    return new Map();
  }
  const resolvedIntermediateDir = resolveIntermediateDir(intermediateDir);
  if (resolvedIntermediateDir) {
    const cachedStore = await tryLoadVectorStoreCache(
      config,
      vectorStore,
      resolvedIntermediateDir,
    ).catch(() => undefined);
    if (cachedStore) {
      const cache = new Map<string, number[]>();
      for (const record of cachedStore.records) {
        if (!record.hash) continue;
        cache.set(
          record.hash,
          Array.from(
            cachedStore.embeddings.subarray(
              record.embeddingOffset,
              record.embeddingOffset + cachedStore.meta.dim,
            ),
          ),
        );
      }
      return cache;
    }
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
  options: WriteVectorStoreOptions = {},
): Promise<void> {
  await writeJsonLinesAtomic(vectorStore, vectorStoreJsonLines(meta, records));
  const intermediateDir = resolveIntermediateDir(options.intermediateDir);
  if (intermediateDir) {
    await writeVectorStoreCacheFromRecords(meta, records, vectorStore, intermediateDir);
  }
}
