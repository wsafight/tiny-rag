// ingest.ts
// -----------------------------------------------------------------------------
// 文档导入库：把文档目录下的文本文件转成本地向量库。
//
// 当前功能：
//   1) 递归读取 documentsDir 下的受支持文档；
//   2) 语义切块：先按 Markdown 标题分节，再按空行段落聚合到 chunkSize 以内，
//      段落自身仍超长时按字符数硬切，并保留 CHUNK_OVERLAP 字符的重叠；
//   3) 每个 chunk 携带所属的多级标题路径（heading）以及内容 SHA1（hash）；
//   4) 基于 hash 的增量缓存：复用旧向量库中相同 hash 的 embedding，未命中
//      的部分才调用 embedding 接口；
//   5) 写盘前对所有向量做 L2 归一化；
//   6) 输出格式为 NDJSON：第一行是 _meta（version/provider/model/dim/...）
//      其余每行一条 chunk 记录；先写临时文件再 rename，保证原子替换。
// 本文件只导出可复用函数；CLI 负责读取环境变量和打印进度。
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import {
  DEFAULT_DOCUMENTS_DIR,
  DEFAULT_VECTOR_STORE,
  VECTOR_STORE_SCHEMA_VERSION,
} from '../constants/index';
import { splitSemantic } from './chunking';
import { loadDocuments, normalizeDocumentExtensions } from './documents';
import { buildKeywordStats } from '../query/keyword';
import { readEmbeddingCache, writeVectorStore } from '../storage/vector-store';
import {
  invariant,
  normalize,
  hasValidEmbedding,
  runWithConcurrency,
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
 * 将文档列表切块，生成带 source / heading / hash 等元信息的 chunk 数组。
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
      const hash = crypto.createHash('sha1').update(embeddingText).digest('hex');
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
 * 加载 -> 切块 -> 命中缓存 -> 仅对未命中的 chunk 调用 embedding -> 归一化 -> 写盘。
 */
export async function ingest(options: IngestOptions): Promise<IngestResult> {
  const resolved = resolveIngestOptions(options);
  const config = resolved.embeddingConfig;

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

  // 命中缓存的 chunk 直接复用旧向量；剩下的再分批请求 embedding
  const cache = await readEmbeddingCache(config, resolved.vectorStore);
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

  // 把 todoIdx 切成多个 batch，再用 INGEST_CONCURRENCY 控制 batch 之间的并发
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
      `[ingest] embedding 返回数量不匹配：输入 ${inputs.length} 条，返回 ${vectors?.length ?? '非数组'}`,
    );
    batchIdx.forEach((j, k) => {
      const vector = vectors[k];
      invariant(!hasValidEmbedding(vector), `[ingest] chunk ${records[j].id} 得到了非法 embedding`);
      records[j].embedding = normalize(vector);
    });
    done += batchIdx.length;
    resolved.onProgress?.({ type: 'embedded', done, total: todoIdx.length });
  });
  await runWithConcurrency(tasks, resolved.concurrency);

  // 旧缓存里的向量未必归一化过，这里统一兜底处理一次
  for (const r of records) {
    if (hasValidEmbedding(r.embedding)) r.embedding = normalize(r.embedding);
  }

  const dim = records[0]?.embedding?.length ?? 0;

  // 仍有 chunk 没拿到 embedding，或维度与其它 chunk 不一致时直接 fail-fast，避免写出脏数据
  const bad = records.find((r) => !hasValidEmbedding(r.embedding, dim));
  invariant(
    bad !== undefined,
    `[ingest] chunk ${bad?.id} 没有得到合法且维度一致的 embedding，已中止写盘`,
  );

  const meta = {
    version: VECTOR_STORE_SCHEMA_VERSION,
    provider: config.provider,
    model: config.model,
    dim,
    chunkSize: resolved.chunkSize,
    chunkOverlap: resolved.chunkOverlap,
    headingWeight: resolved.headingWeight,
    createdAt: new Date().toISOString(),
  };

  await writeVectorStore(meta, records, resolved.vectorStore);
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
