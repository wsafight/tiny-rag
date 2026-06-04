// ingest.ts
// -----------------------------------------------------------------------------
// Document ingestion library: turns text files under the documents directory into a local vector store.
//
// Current features:
//   1) Recursively read supported documents under documentsDir;
//   2) Semantic chunking: split by Markdown headings first, then aggregate paragraphs by
//      blank lines up to chunkSize; when a paragraph itself is too long, hard-split it by
//      character count, keeping CHUNK_OVERLAP characters of overlap;
//   3) Each chunk carries its multi-level heading path (heading) and content SHA1 (hash);
//   4) Hash-based incremental cache: reuse embeddings with the same hash from the old vector
//      store, only calling the embedding API for the misses;
//   5) L2-normalize all vectors before writing to disk;
//   6) Output format is NDJSON: the first line is _meta (version/provider/model/dim/...)
//      and every other line is one chunk record; write to a temp file then rename for atomic replacement.
// This file only exports reusable functions; the CLI handles reading env vars and printing progress.
// -----------------------------------------------------------------------------

import {
  DEFAULT_DOCUMENTS_DIR,
  DEFAULT_VECTOR_STORE,
  VECTOR_STORE_SCHEMA_VERSION,
} from '../constants/index';
import { splitSemantic } from './chunking';
import { loadDocuments, normalizeDocumentExtensions } from './documents';
import { buildKeywordStats } from '../query/keyword';
import {
  clearIntermediateCache,
  loadVectorStore,
  readEmbeddingCache,
  readVectorStoreMeta,
  writeVectorStore,
} from '../storage/vector-store';
import {
  invariant,
  normalize,
  hasValidEmbedding,
  runWithConcurrency,
  createSha1,
  updateHashWithJson,
} from '../utils/index';
import {
  assertLessThan,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertPositiveInteger,
} from '../utils/validation';
import type {
  ChunkDocumentFunction,
  ChunkRecord,
  IngestOptions,
  IngestResult,
  SourceDocument,
} from './types';
import type { EmbedFunction, EmbeddingConfig } from '../providers/types';

type PendingVectorRecord = ChunkRecord & {
  embedding: number[] | null;
};

export const DEFAULT_CHUNK_SIZE = 600;
export const DEFAULT_CHUNK_OVERLAP = 80;
export const DEFAULT_HEADING_WEIGHT = 2;
export const DEFAULT_EMBED_BATCH_SIZE = 32;
export const DEFAULT_INGEST_CONCURRENCY = 1;

interface ResolvedIngestOptions {
  documentsDir: string;
  vectorStore: string;
  intermediateDir?: string;
  documentExtensions: string[];
  sourceRoot: string;
  excludeSources: readonly string[];
  filterDocument?: IngestOptions['filterDocument'];
  chunkSize: number;
  chunkOverlap: number;
  chunkDocument?: ChunkDocumentFunction;
  headingWeight: number;
  embedBatchSize: number;
  concurrency: number;
  embeddingConfig: EmbeddingConfig;
  embed: EmbedFunction;
  onProgress?: IngestOptions['onProgress'];
}

interface BuildChunkRecordsOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  chunkDocument?: ChunkDocumentFunction;
  headingWeight?: number;
}

function buildIngestFingerprint(
  chunks: readonly ChunkRecord[],
  resolved: ResolvedIngestOptions,
): string {
  const hash = createSha1();
  updateHashWithJson(hash, {
    fingerprintVersion: 1,
    schemaVersion: VECTOR_STORE_SCHEMA_VERSION,
    provider: resolved.embeddingConfig.provider,
    model: resolved.embeddingConfig.model,
    chunkSize: resolved.chunkSize,
    chunkOverlap: resolved.chunkOverlap,
    headingWeight: resolved.headingWeight,
  });

  for (const chunk of chunks) {
    updateHashWithJson(hash, {
      id: chunk.id,
      source: chunk.source,
      chunkIndex: chunk.chunkIndex,
      hash: chunk.hash,
      keywordHeadingTerms: chunk.keywordHeadingTerms,
      keywordHeadingTokenCount: chunk.keywordHeadingTokenCount,
      keywordContentTerms: chunk.keywordContentTerms,
      keywordContentTokenCount: chunk.keywordContentTokenCount,
    });
  }
  return hash.digest('hex');
}

async function readUnchangedVectorStoreMeta(
  config: EmbeddingConfig,
  vectorStore: string,
  ingestFingerprint: string,
): Promise<IngestResult['meta'] | undefined> {
  try {
    const meta = await readVectorStoreMeta(config, vectorStore);
    return meta.ingestFingerprint === ingestFingerprint ? meta : undefined;
  } catch {
    return undefined;
  }
}

export function buildEmbeddingText(heading: string, content: string, headingWeight = 1): string {
  const cleanHeading = heading.trim();
  const cleanContent = content.trim();
  const repeatCount = Math.max(0, Math.floor(headingWeight));
  if (!cleanHeading || repeatCount === 0) return cleanContent;
  return `${Array(repeatCount).fill(cleanHeading).join('\n')}\n${cleanContent}`;
}

function resolveIngestOptions(options: IngestOptions): ResolvedIngestOptions {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const headingWeight = options.headingWeight ?? DEFAULT_HEADING_WEIGHT;
  const embedBatchSize = options.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_INGEST_CONCURRENCY;

  assertPositiveInteger('chunkSize', chunkSize);
  assertNonNegativeInteger('chunkOverlap', chunkOverlap);
  assertLessThan('chunkOverlap', chunkOverlap, 'chunkSize', chunkSize);
  assertNonNegativeNumber('headingWeight', headingWeight);
  assertPositiveInteger('embedBatchSize', embedBatchSize);
  assertPositiveInteger('concurrency', concurrency);

  return {
    documentsDir: options.documentsDir ?? DEFAULT_DOCUMENTS_DIR,
    vectorStore: options.vectorStore ?? DEFAULT_VECTOR_STORE,
    intermediateDir: options.intermediateDir,
    documentExtensions: normalizeDocumentExtensions(options.documentExtensions),
    sourceRoot: options.sourceRoot ?? options.documentsDir ?? DEFAULT_DOCUMENTS_DIR,
    excludeSources: options.excludeSources ?? [],
    filterDocument: options.filterDocument,
    chunkSize,
    chunkOverlap,
    chunkDocument: options.chunkDocument,
    headingWeight,
    embedBatchSize,
    concurrency,
    embeddingConfig: options.embeddingConfig,
    embed: options.embed,
    onProgress: options.onProgress,
  };
}

/**
 * Chunk a list of documents into chunk records carrying source / heading / hash metadata.
 */
export function buildChunkRecords(
  docs: readonly SourceDocument[],
  options: BuildChunkRecordsOptions = {},
): ChunkRecord[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const headingWeight = options.headingWeight ?? DEFAULT_HEADING_WEIGHT;
  assertPositiveInteger('chunkSize', chunkSize);
  assertNonNegativeInteger('chunkOverlap', chunkOverlap);
  assertLessThan('chunkOverlap', chunkOverlap, 'chunkSize', chunkSize);
  assertNonNegativeNumber('headingWeight', headingWeight);

  const records: ChunkRecord[] = [];
  for (const doc of docs) {
    const pieces = options.chunkDocument
      ? options.chunkDocument(doc, { chunkSize, chunkOverlap })
      : splitSemantic(doc.content, chunkSize, chunkOverlap);
    pieces.forEach((piece, index) => {
      const embeddingText = buildEmbeddingText(piece.heading, piece.content, headingWeight);
      const keywordStats = buildKeywordStats(piece.heading, piece.content);
      const hash = createSha1().update(embeddingText).digest('hex');
      records.push({
        id: `${doc.source}#${index}`,
        source: doc.source,
        chunkIndex: index,
        heading: piece.heading,
        content: piece.content,
        embeddingText,
        hash,
        ...keywordStats,
      });
    });
  }
  return records;
}

/**
 * Load -> chunk -> hit cache -> embed only the misses -> normalize -> write to disk.
 */
export async function ingest(options: IngestOptions): Promise<IngestResult> {
  const resolved = resolveIngestOptions(options);
  const config = resolved.embeddingConfig;

  await clearIntermediateCache(resolved.intermediateDir);

  const docs = await loadDocuments(resolved.documentsDir, {
    extensions: resolved.documentExtensions,
    sourceRoot: resolved.sourceRoot,
    excludeSources: resolved.excludeSources,
    filterDocument: resolved.filterDocument,
  });
  resolved.onProgress?.({ type: 'loaded-docs', docsCount: docs.length });
  if (docs.length === 0) {
    return {
      embeddingConfig: config,
      documentsDir: resolved.documentsDir,
      vectorStore: resolved.vectorStore,
      docsCount: 0,
      chunksCount: 0,
      cachedCount: 0,
      embeddedCount: 0,
      skippedReason: 'no-docs',
    };
  }

  const chunks = buildChunkRecords(docs, {
    chunkSize: resolved.chunkSize,
    chunkOverlap: resolved.chunkOverlap,
    chunkDocument: resolved.chunkDocument,
    headingWeight: resolved.headingWeight,
  });
  resolved.onProgress?.({
    type: 'built-chunks',
    chunksCount: chunks.length,
    chunkSize: resolved.chunkSize,
    chunkOverlap: resolved.chunkOverlap,
  });
  if (chunks.length === 0) {
    return {
      embeddingConfig: config,
      documentsDir: resolved.documentsDir,
      vectorStore: resolved.vectorStore,
      docsCount: docs.length,
      chunksCount: 0,
      cachedCount: 0,
      embeddedCount: 0,
      skippedReason: 'no-chunks',
    };
  }

  const ingestFingerprint = buildIngestFingerprint(chunks, resolved);
  const unchangedMeta = await readUnchangedVectorStoreMeta(
    config,
    resolved.vectorStore,
    ingestFingerprint,
  );
  if (unchangedMeta) {
    if (resolved.intermediateDir) {
      await loadVectorStore(config, {
        vectorStore: resolved.vectorStore,
        intermediateDir: resolved.intermediateDir,
      });
    }
    return {
      embeddingConfig: config,
      documentsDir: resolved.documentsDir,
      vectorStore: resolved.vectorStore,
      docsCount: docs.length,
      chunksCount: chunks.length,
      cachedCount: chunks.length,
      embeddedCount: 0,
      meta: unchangedMeta,
      skippedReason: 'unchanged',
    };
  }

  // Chunks that hit the cache reuse the old vectors directly; the rest are embedded in batches
  const cache = await readEmbeddingCache(config, resolved.vectorStore, resolved.intermediateDir);
  const records: PendingVectorRecord[] = chunks.map((c) => {
    const cached = cache.get(c.hash);
    return { ...c, embedding: hasValidEmbedding(cached) ? cached : null };
  });
  const todoIdx: number[] = [];
  records.forEach((r, i) => {
    if (!hasValidEmbedding(r.embedding)) todoIdx.push(i);
  });
  const cachedCount = chunks.length - todoIdx.length;
  resolved.onProgress?.({
    type: 'cache',
    cachedCount,
    pendingCount: todoIdx.length,
    total: chunks.length,
  });

  // Split todoIdx into batches, then use INGEST_CONCURRENCY to control concurrency between batches
  const batches: number[][] = [];
  for (let i = 0; i < todoIdx.length; i += resolved.embedBatchSize) {
    batches.push(todoIdx.slice(i, i + resolved.embedBatchSize));
  }

  let done = 0;
  const tasks = batches.map((batchIdx) => async () => {
    const inputs = batchIdx.map((j) => records[j].embeddingText);
    const vectors = await resolved.embed(inputs);
    invariant(
      !Array.isArray(vectors) || vectors.length !== inputs.length,
      `[ingest] embedding count mismatch: ${inputs.length} inputs sent, ${vectors?.length ?? 'not an array'} returned`,
    );
    batchIdx.forEach((j, k) => {
      const vector = vectors[k];
      invariant(!hasValidEmbedding(vector), `[ingest] chunk ${records[j].id} got an invalid embedding`);
      records[j].embedding = normalize(vector);
    });
    done += batchIdx.length;
    resolved.onProgress?.({ type: 'embedded', done, total: todoIdx.length });
  });
  await runWithConcurrency(tasks, resolved.concurrency);

  // Some chunks did not get embeddings yet, or their cached vectors are not normalized; do a unified fallback pass here
  for (const r of records) {
    if (hasValidEmbedding(r.embedding)) r.embedding = normalize(r.embedding);
  }

  const dim = records[0]?.embedding?.length ?? 0;

  // If any chunk still lacks an embedding or its dim is inconsistent with others, fail-fast to avoid writing dirty data
  const bad = records.find((r) => !hasValidEmbedding(r.embedding, dim));
  invariant(
    bad !== undefined,
    `[ingest] chunk ${bad?.id} did not get a valid embedding with consistent dim; aborting write`,
  );

  const meta = {
    version: VECTOR_STORE_SCHEMA_VERSION,
    provider: config.provider,
    model: config.model,
    dim,
    chunkSize: resolved.chunkSize,
    chunkOverlap: resolved.chunkOverlap,
    headingWeight: resolved.headingWeight,
    ingestFingerprint,
    createdAt: new Date().toISOString(),
  };

  const storedRecords = records.map(({ embeddingText: _embeddingText, ...rest }) => rest);
  await writeVectorStore(meta, storedRecords, resolved.vectorStore, {
    intermediateDir: resolved.intermediateDir,
  });
  resolved.onProgress?.({
    type: 'written',
    vectorStore: resolved.vectorStore,
    dim,
    version: VECTOR_STORE_SCHEMA_VERSION,
    lines: records.length + 1,
  });

  return {
    embeddingConfig: config,
    documentsDir: resolved.documentsDir,
    vectorStore: resolved.vectorStore,
    docsCount: docs.length,
    chunksCount: chunks.length,
    cachedCount,
    embeddedCount: todoIdx.length,
    meta,
  };
}
