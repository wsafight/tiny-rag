import { DEFAULT_VECTOR_STORE } from '../constants/index';
import { loadVectorStore, type LoadedVectorStore } from '../storage/vector-store';
import { invariant } from '../utils/index';
import {
  assertNonNegativeNumber,
  assertNumberInRange,
  assertPositiveInteger,
} from '../utils/validation';
import { buildKeywordStats, tokenizeForKeyword } from './keyword';
import type { EmbeddingConfig } from '../providers/types';
import type { KeywordStats, StoreMeta, TermCounts } from '../storage/types';
import type {
  RankingOptions,
  RetrieverSearchOptions,
  SearchHit,
  SearchOptions,
  SearchResult,
  VectorStoreRetriever,
} from './types';

export { tokenizeForKeyword } from './keyword';

export const DEFAULT_QUERY_VECTOR_STORE = DEFAULT_VECTOR_STORE;
export const DEFAULT_TOP_K = 4;
export const DEFAULT_MIN_SCORE = 0;
export const DEFAULT_PER_SOURCE_LIMIT = 2;
export const DEFAULT_KEYWORD_WEIGHT = 0.3;
export const DEFAULT_KEYWORD_HEADING_WEIGHT = 2;

interface ResolvedRankingOptions {
  topK: number;
  minScore: number;
  perSourceLimit: number;
  keywordWeight: number;
  keywordHeadingWeight: number;
}

interface ResolvedSearchOptions extends ResolvedRankingOptions {
  vectorStore: string;
  embeddingConfig: EmbeddingConfig;
  onWarning?: SearchOptions['onWarning'];
}

interface IndexedKeywordStats {
  headingTerms: ReadonlyMap<string, number>;
  headingTokenCount: number;
  contentTerms: ReadonlyMap<string, number>;
  contentTokenCount: number;
}

type LoadedVectorStoreRecord = LoadedVectorStore['records'][number];

interface IndexedVectorStoreRecord extends LoadedVectorStoreRecord {
  keyword: IndexedKeywordStats;
}

interface IndexedVectorStore {
  meta: StoreMeta;
  records: IndexedVectorStoreRecord[];
}

export function resolveRankingOptions(options: RankingOptions = {}): ResolvedRankingOptions {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const perSourceLimit = options.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT;
  const keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
  const keywordHeadingWeight = options.keywordHeadingWeight ?? DEFAULT_KEYWORD_HEADING_WEIGHT;

  assertPositiveInteger('topK', topK);
  assertPositiveInteger('perSourceLimit', perSourceLimit);
  assertNumberInRange('minScore', minScore, -1, 1);
  assertNumberInRange('keywordWeight', keywordWeight, 0, 1);
  assertNonNegativeNumber('keywordHeadingWeight', keywordHeadingWeight);

  return {
    topK,
    minScore,
    perSourceLimit,
    keywordWeight,
    keywordHeadingWeight,
  };
}

export function resolveSearchOptions(
  options: SearchOptions & { embeddingConfig: EmbeddingConfig },
): ResolvedSearchOptions {
  return {
    ...resolveRankingOptions(options),
    vectorStore: options.vectorStore ?? DEFAULT_QUERY_VECTOR_STORE,
    embeddingConfig: options.embeddingConfig,
    onWarning: options.onWarning,
  };
}

function scoreBm25(
  record: IndexedVectorStoreRecord,
  docFreqs: ReadonlyMap<string, number>,
  queryTermCounts: ReadonlyMap<string, number>,
  docCount: number,
  avgTokenCount: number,
  headingRepeatCount: number,
): number {
  const tokenCount = getWeightedKeywordTokenCount(record, headingRepeatCount);
  if (docCount === 0 || tokenCount === 0 || avgTokenCount === 0) return 0;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const [term, queryTf] of queryTermCounts) {
    const tf = getWeightedKeywordTermCount(record, term, headingRepeatCount);
    if (tf === 0) continue;
    const df = docFreqs.get(term) ?? 0;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (tokenCount / avgTokenCount));
    score += queryTf * idf * ((tf * (k1 + 1)) / denom);
  }
  return score;
}

function insertByAscendingScore<T extends { score: number }>(arr: T[], item: T): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].score < item.score) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
}

export function selectDiverseHits<T extends { source: string }>(
  hits: readonly T[],
  opts: { perSourceLimit?: number; maxTotal?: number } = {},
): T[] {
  const perSourceLimit = Math.max(1, opts.perSourceLimit ?? 2);
  const maxTotal = Math.max(1, opts.maxTotal ?? hits.length);
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const hit of hits) {
    const used = counts.get(hit.source) || 0;
    if (used >= perSourceLimit) continue;
    out.push(hit);
    counts.set(hit.source, used + 1);
    if (out.length >= maxTotal) break;
  }
  return out;
}

function countQueryTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function hasCompleteKeywordStats(source: KeywordStats): source is Required<KeywordStats> {
  return (
    Array.isArray(source.keywordContentTerms) &&
    typeof source.keywordContentTokenCount === 'number' &&
    Array.isArray(source.keywordHeadingTerms) &&
    typeof source.keywordHeadingTokenCount === 'number'
  );
}

function toTermMap(entries: TermCounts): ReadonlyMap<string, number> {
  return new Map(entries);
}

function indexKeywordStats(record: LoadedVectorStoreRecord): IndexedKeywordStats {
  const stats = hasCompleteKeywordStats(record)
    ? record
    : buildKeywordStats(record.heading, record.content);

  return {
    headingTerms: toTermMap(stats.keywordHeadingTerms),
    headingTokenCount: stats.keywordHeadingTokenCount,
    contentTerms: toTermMap(stats.keywordContentTerms),
    contentTokenCount: stats.keywordContentTokenCount,
  };
}

function createSearchIndex(store: LoadedVectorStore): IndexedVectorStore {
  return {
    meta: store.meta,
    records: store.records.map((record) => ({
      ...record,
      keyword: indexKeywordStats(record),
    })),
  };
}

function getWeightedKeywordTermCount(
  record: IndexedVectorStoreRecord,
  term: string,
  headingRepeatCount: number,
): number {
  const contentCount = record.keyword.contentTerms.get(term) ?? 0;
  if (headingRepeatCount === 0) return contentCount;
  return contentCount + (record.keyword.headingTerms.get(term) ?? 0) * headingRepeatCount;
}

function getWeightedKeywordTokenCount(
  record: IndexedVectorStoreRecord,
  headingRepeatCount: number,
): number {
  return (
    record.keyword.contentTokenCount +
    record.keyword.headingTokenCount * headingRepeatCount
  );
}

function dotEmbedding(a: readonly number[], b: ArrayLike<number>): number {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

function scoreLoadedVectorStore(
  store: IndexedVectorStore,
  queryEmbedding: readonly number[],
  queryText: string,
  resolved: ResolvedRankingOptions,
): SearchResult {
  invariant(
    queryEmbedding.length !== store.meta.dim,
    `向量库 dim=${store.meta.dim} 与当前向量 dim=${queryEmbedding.length} 不一致，请重新生成向量库`,
  );
  invariant(store.records.length === 0, '[query] 向量库为空，或所有 embedding 都非法');

  const candidatePool = Math.max(resolved.topK, resolved.topK * resolved.perSourceLimit);
  const queryTokens = tokenizeForKeyword(queryText);
  const queryTermCounts = countQueryTokens(queryTokens);
  const queryTerms = [...queryTermCounts.keys()];
  const useKeyword = resolved.keywordWeight > 0 && queryTerms.length > 0;
  const headingRepeatCount = Math.max(0, Math.floor(resolved.keywordHeadingWeight));

  const docFreqs = new Map<string, number>();
  let totalTokenCount = 0;

  if (useKeyword) {
    for (const record of store.records) {
      totalTokenCount += getWeightedKeywordTokenCount(record, headingRepeatCount);
      for (const term of queryTerms) {
        if (getWeightedKeywordTermCount(record, term, headingRepeatCount) > 0) {
          docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
        }
      }
    }
  }

  const avgTokenCount = useKeyword ? totalTokenCount / store.records.length : 0;
  let maxKeywordScore = 0;
  const rawKeywordScores = useKeyword ? new Array<number>(store.records.length) : undefined;
  if (useKeyword) {
    for (let i = 0; i < store.records.length; i++) {
      const score = scoreBm25(
        store.records[i],
        docFreqs,
        queryTermCounts,
        store.records.length,
        avgTokenCount,
        headingRepeatCount,
      );
      rawKeywordScores![i] = score;
      if (score > maxKeywordScore) maxKeywordScore = score;
    }
  }

  const pool: SearchHit[] = [];
  for (let i = 0; i < store.records.length; i++) {
    const record = store.records[i];
    const rawKeywordScore = rawKeywordScores?.[i] ?? 0;
    const keywordScore = maxKeywordScore > 0 ? rawKeywordScore / maxKeywordScore : 0;
    const vectorScore = dotEmbedding(queryEmbedding, record.embedding);
    const vectorWeight = 1 - resolved.keywordWeight;
    const score = vectorWeight * vectorScore + resolved.keywordWeight * keywordScore;
    if (resolved.minScore > 0 && score < resolved.minScore) continue;

    const hit: SearchHit = {
      id: record.id,
      source: record.source,
      chunkIndex: record.chunkIndex,
      heading: record.heading,
      content: record.content,
      score,
      vectorScore,
      keywordScore,
    };

    if (pool.length < candidatePool) {
      insertByAscendingScore(pool, hit);
    } else if (score > pool[0].score) {
      pool.shift();
      insertByAscendingScore(pool, hit);
    }
  }

  return { meta: store.meta, hits: pool.reverse() };
}

export function createLoadedRetriever(
  embConfig: EmbeddingConfig,
  store: LoadedVectorStore,
  defaults: RetrieverSearchOptions = {},
): VectorStoreRetriever {
  const index = createSearchIndex(store);
  return {
    meta: index.meta,
    recordCount: index.records.length,
    search(queryEmbedding, queryText, options = {}) {
      const resolved = resolveRankingOptions({
        ...defaults,
        ...options,
      });
      return scoreLoadedVectorStore(index, queryEmbedding, queryText, resolved);
    },
  };
}

export async function createRetriever(
  embConfig: EmbeddingConfig,
  options: SearchOptions = {},
): Promise<VectorStoreRetriever> {
  const resolved = resolveSearchOptions({ ...options, embeddingConfig: embConfig });
  const store = await loadVectorStore(embConfig, {
    vectorStore: resolved.vectorStore,
    onWarning: resolved.onWarning,
  });
  return createLoadedRetriever(embConfig, store, resolved);
}

export async function searchVectorStore(
  embConfig: EmbeddingConfig,
  queryEmbedding: readonly number[],
  queryText: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const retriever = await createRetriever(embConfig, options);
  return retriever.search(queryEmbedding, queryText, options);
}
