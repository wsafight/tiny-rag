import type {
  ChatFunction,
  ChatMessage,
  EmbedFunction,
  EmbeddingConfig,
  LLMConfig,
} from '../providers/types';
import type { StoreMeta } from '../storage/types';

export interface SearchHit {
  id: string;
  source: string;
  chunkIndex: number;
  heading: string;
  content: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
}

export interface RankingOptions {
  topK?: number;
  minScore?: number;
  perSourceLimit?: number;
  keywordWeight?: number;
  keywordHeadingWeight?: number;
}

export interface VectorStoreOptions {
  vectorStore?: string;
  intermediateDir?: string;
  onWarning?: (message: string) => void;
}

export interface SearchOptions extends VectorStoreOptions, RankingOptions {}

export type RetrieverSearchOptions = RankingOptions;

export interface SearchResult {
  meta: StoreMeta;
  hits: SearchHit[];
}

export interface VectorStoreRetriever {
  meta: StoreMeta;
  recordCount: number;
  search(
    queryEmbedding: ArrayLike<number>,
    queryText: string,
    options?: RetrieverSearchOptions,
  ): SearchResult;
}

export interface PromptOptions {
  systemPrompt?: string;
  contextLabel?: string;
  questionLabel?: string;
  unknownAnswer?: string;
}

export interface QueryOptions extends SearchOptions {
  embeddingConfig: EmbeddingConfig;
  llmConfig: LLMConfig;
  embed: EmbedFunction;
  chat: ChatFunction;
  prompt?: PromptOptions;
  buildMessages?: (context: string, question: string) => readonly ChatMessage[];
  retriever?: VectorStoreRetriever;
  stream?: boolean;
  includeCandidates?: boolean;
  includeContext?: boolean;
  onToken?: (token: string) => void;
  onRetrieved?: (result: {
    candidates: SearchHit[];
    hits: SearchHit[];
    embeddingElapsedMs: number;
    searchElapsedMs: number;
    retrievalElapsedMs: number;
  }) => void;
}

export interface QueryResult {
  question: string;
  answer: string;
  llmConfig: LLMConfig;
  embeddingConfig: EmbeddingConfig;
  meta: StoreMeta;
  candidates?: SearchHit[];
  hits: SearchHit[];
  context?: string;
  embeddingElapsedMs: number;
  searchElapsedMs: number;
  retrievalElapsedMs: number;
  generationElapsedMs?: number;
  noAnswerReason?: 'no-hits';
}
