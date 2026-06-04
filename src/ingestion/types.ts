import type { EmbedFunction, EmbeddingConfig } from '../providers/types';
import type { KeywordStats, StoreMeta } from '../storage/types';

export interface SourceDocument {
  source: string;
  content: string;
}

export interface LoadDocumentsOptions {
  extensions?: readonly string[];
  sourceRoot?: string;
  excludeSources?: readonly string[];
  filterDocument?: (document: SourceDocument) => boolean;
}

export interface SemanticChunk {
  content: string;
  heading: string;
}

export interface ChunkDocumentOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export type ChunkDocumentFunction = (
  document: SourceDocument,
  options: ChunkDocumentOptions,
) => readonly SemanticChunk[];

export interface ChunkRecord extends SemanticChunk, KeywordStats {
  id: string;
  source: string;
  chunkIndex: number;
  embeddingText: string;
  hash: string;
}

export type IngestProgressEvent =
  | { type: 'loaded-docs'; docsCount: number }
  | { type: 'built-chunks'; chunksCount: number; chunkSize: number; chunkOverlap: number }
  | { type: 'cache'; cachedCount: number; pendingCount: number; total: number }
  | { type: 'embedded'; done: number; total: number }
  | { type: 'written'; vectorStore: string; dim: number; version: number; lines: number };

export interface IngestOptions {
  embeddingConfig: EmbeddingConfig;
  embed: EmbedFunction;
  documentsDir?: string;
  vectorStore?: string;
  documentExtensions?: readonly string[];
  sourceRoot?: string;
  excludeSources?: readonly string[];
  filterDocument?: (document: SourceDocument) => boolean;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkDocument?: ChunkDocumentFunction;
  headingWeight?: number;
  embedBatchSize?: number;
  concurrency?: number;
  onProgress?: (event: IngestProgressEvent) => void;
}

export interface IngestResult {
  embeddingConfig: EmbeddingConfig;
  documentsDir: string;
  vectorStore: string;
  docsCount: number;
  chunksCount: number;
  cachedCount: number;
  embeddedCount: number;
  meta?: StoreMeta;
  skippedReason?: 'no-docs' | 'no-chunks';
}
