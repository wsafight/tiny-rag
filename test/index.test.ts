// test/index.test.ts
// -----------------------------------------------------------------------------
// 覆盖 src 统一出口，确保可复用代码可安全 import，不触发 CLI 执行。
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as rag from '../src/index';

test('index: 导出核心函数', () => {
  assert.equal(typeof rag.ingest, 'function');
  assert.equal(typeof rag.query, 'function');
  assert.equal(typeof rag.embed, 'function');
  assert.equal(typeof rag.chat, 'function');
  assert.equal(typeof rag.createEmbedder, 'function');
  assert.equal(typeof rag.createChat, 'function');
  assert.equal(typeof rag.createRetriever, 'function');
  assert.equal(typeof rag.buildChunkRecords, 'function');
  assert.equal(typeof rag.buildEmbeddingText, 'function');
  assert.equal(typeof rag.loadDocuments, 'function');
  assert.equal(typeof rag.buildContext, 'function');
  assert.equal(typeof rag.buildMessages, 'function');
  assert.equal(typeof rag.tokenizeForKeyword, 'function');
  assert.equal(typeof rag.selectDiverseHits, 'function');
  assert.equal(rag.DEFAULT_DOCUMENTS_DIR, './documents');
  assert.equal(rag.DEFAULT_VECTOR_STORE, './vector-store.ndjson');
  assert.equal(Object.hasOwn(rag, 'invariant'), false);
  assert.equal(Object.hasOwn(rag, 'loadVectorStore'), false);
});
