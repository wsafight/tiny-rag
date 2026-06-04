export type TermCounts = Array<[term: string, count: number]>;

export interface KeywordStats {
  keywordHeadingTerms?: TermCounts;
  keywordHeadingTokenCount?: number;
  keywordContentTerms?: TermCounts;
  keywordContentTokenCount?: number;
}

export interface StoreMeta {
  version: number;
  provider: string;
  model: string;
  dim: number;
  chunkSize: number;
  chunkOverlap: number;
  headingWeight?: number;
  createdAt: string;
}

export interface VectorRecord extends KeywordStats {
  id: string;
  source: string;
  chunkIndex: number;
  heading: string;
  content: string;
  embeddingText: string;
  hash: string;
  embedding: number[];
}
