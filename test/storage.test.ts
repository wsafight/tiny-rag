// test/storage.test.ts
// -----------------------------------------------------------------------------
// 覆盖本地 NDJSON 向量库的读写、校验、容错和缓存读取行为。
// -----------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVectorStore,
  readEmbeddingCache,
  readVectorStoreMeta,
  streamVectorStoreRecords,
  validateVectorStoreMeta,
  writeVectorStore,
} from '../src/storage/vector-store';
import { VECTOR_STORE_SCHEMA_VERSION } from '../src/constants/index';
import type { EmbeddingConfig } from '../src/types';
import type { StoreMeta } from '../src/storage/types';

const embeddingConfig: EmbeddingConfig = {
  provider: 'lmstudio',
  baseURL: 'http://example.test/v1',
  apiKey: 'test',
  model: 'test-embedding',
};

function validMeta(overrides: Partial<StoreMeta> = {}): StoreMeta {
  return {
    version: VECTOR_STORE_SCHEMA_VERSION,
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dim: 2,
    chunkSize: 100,
    chunkOverlap: 10,
    headingWeight: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function makeTempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tiny-rag-storage-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRawStore(file: string, lines: readonly unknown[]): Promise<void> {
  await writeFile(
    file,
    lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n') + '\n',
  );
}

test('writeVectorStore/loadVectorStore: 创建目录并加载连续 Float32Array embedding 矩阵', async (t) => {
  const dir = await makeTempDir(t);
  const vectorStore = join(dir, 'nested', 'store.ndjson');

  await writeVectorStore(
    validMeta(),
    [
      {
        id: 'doc.md#0',
        source: 'doc.md',
        chunkIndex: 0,
        heading: 'Cache',
        content: 'Cache ttl is 30 minutes.',
        hash: 'hash-1',
        embedding: [1, 0],
        keywordHeadingTerms: [['cache', 1]],
        keywordHeadingTokenCount: 1,
        keywordContentTerms: [['cache', 1]],
        keywordContentTokenCount: 1,
      },
      {
        id: 'doc.md#1',
        source: 'doc.md',
        chunkIndex: 1,
        heading: 'Queue',
        content: 'Queue retries failed jobs.',
        hash: 'hash-2',
        embedding: [0, 1],
      },
    ],
    vectorStore,
  );

  const raw = await readFile(vectorStore, 'utf-8');
  assert.equal(raw.trim().split('\n').length, 3);

  const loaded = await loadVectorStore(embeddingConfig, { vectorStore });
  assert.equal(loaded.meta.dim, 2);
  assert.equal(loaded.records.length, 2);
  assert.ok(loaded.embeddings instanceof Float32Array);
  assert.deepEqual([...loaded.embeddings], [1, 0, 0, 1]);
  assert.equal(loaded.records[0].embeddingOffset, 0);
  assert.equal(loaded.records[1].embeddingOffset, 2);
  assert.deepEqual(loaded.records[0].keywordHeadingTerms, [['cache', 1]]);
});

test('writeVectorStore/loadVectorStore: 配置 intermediateDir 时写入并读取中间态缓存', async (t) => {
  const dir = await makeTempDir(t);
  const vectorStore = join(dir, 'store.ndjson');
  const intermediateDir = join(dir, 'intermediate');

  await writeVectorStore(
    validMeta(),
    [
      {
        id: 'doc.md#0',
        source: 'doc.md',
        chunkIndex: 0,
        heading: 'Cache',
        content: 'Cache ttl is 30 minutes.',
        hash: 'hash-1',
        embedding: [1, 0],
      },
      {
        id: 'doc.md#1',
        source: 'doc.md',
        chunkIndex: 1,
        heading: 'Queue',
        content: 'Queue retries failed jobs.',
        hash: 'hash-2',
        embedding: [0, 1],
      },
    ],
    vectorStore,
    { intermediateDir },
  );

  const cacheFiles = await readdir(intermediateDir);
  assert.equal(cacheFiles.filter((file) => file.endsWith('.manifest.json')).length, 1);
  assert.equal(cacheFiles.filter((file) => file.endsWith('.records.ndjson')).length, 1);
  assert.equal(cacheFiles.filter((file) => file.endsWith('.embeddings.f32')).length, 1);

  const loaded = await loadVectorStore(embeddingConfig, { vectorStore, intermediateDir });
  assert.deepEqual([...loaded.embeddings], [1, 0, 0, 1]);
  assert.deepEqual(
    loaded.records.map((record) => [record.id, record.embeddingOffset]),
    [
      ['doc.md#0', 0],
      ['doc.md#1', 2],
    ],
  );

  const embeddingCache = await readEmbeddingCache(embeddingConfig, vectorStore, intermediateDir);
  assert.deepEqual(embeddingCache.get('hash-1'), [1, 0]);
  assert.deepEqual(embeddingCache.get('hash-2'), [0, 1]);
});

test('streamVectorStoreRecords: 跳过坏行并通过 onWarning 暴露原因', async (t) => {
  const dir = await makeTempDir(t);
  const vectorStore = join(dir, 'store.ndjson');
  await writeRawStore(vectorStore, [
    { _meta: validMeta() },
    '{bad json',
    {
      id: 'bad-embedding',
      source: 'bad.md',
      chunkIndex: 0,
      content: 'bad',
      embedding: [1, 0, 0],
    },
    {
      id: 'missing-content',
      source: 'missing.md',
      chunkIndex: 0,
      embedding: [1, 0],
    },
    {
      id: 'ok.md#0',
      source: 'ok.md',
      chunkIndex: 0,
      content: 'ok',
      embedding: [0, 1],
      keywordContentTerms: [['ok', 1]],
      keywordContentTokenCount: 1,
    },
  ]);

  const warnings: string[] = [];
  const records = [];
  for await (const record of streamVectorStoreRecords(embeddingConfig, {
    vectorStore,
    onWarning: (message) => warnings.push(message),
  })) {
    records.push(record);
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'ok.md#0');
  assert.equal(records[0].heading, '');
  assert.deepEqual(records[0].keywordContentTerms, [['ok', 1]]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /unparseable/);
  assert.match(warnings[1], /dim-mismatched/);
  assert.match(warnings[2], /incomplete fields/);
});

test('readVectorStoreMeta/loadVectorStore: meta 损坏或不匹配时失败', async (t) => {
  const dir = await makeTempDir(t);
  const missingMetaStore = join(dir, 'missing-meta.ndjson');
  const wrongProviderStore = join(dir, 'wrong-provider.ndjson');
  const corruptStore = join(dir, 'corrupt.ndjson');

  await writeRawStore(missingMetaStore, [{ id: 'record-without-meta' }]);
  await writeRawStore(wrongProviderStore, [
    { _meta: validMeta({ provider: 'ollama' }) },
  ]);
  await writeFile(corruptStore, '{bad-json\n');

  await assert.rejects(
    () => readVectorStoreMeta(embeddingConfig, missingMetaStore),
    /missing _meta/,
  );
  await assert.rejects(
    () => loadVectorStore(embeddingConfig, wrongProviderStore ? { vectorStore: wrongProviderStore } : {}),
    /provider=ollama/,
  );
  await assert.rejects(
    () => readVectorStoreMeta(embeddingConfig, corruptStore),
    /first line is corrupted/,
  );
});

test('readEmbeddingCache: 只读取兼容 meta 且带合法 hash 的 embedding', async (t) => {
  const dir = await makeTempDir(t);
  const vectorStore = join(dir, 'store.ndjson');
  await writeRawStore(vectorStore, [
    { _meta: validMeta() },
    { id: 'ok', hash: 'hash-ok', embedding: [1, 0] },
    { id: 'no-hash', embedding: [0, 1] },
    { id: 'bad-embedding', hash: 'hash-bad', embedding: [Number.NaN] },
  ]);

  const cache = await readEmbeddingCache(embeddingConfig, vectorStore);
  assert.deepEqual(cache.get('hash-ok'), [1, 0]);
  assert.equal(cache.has('hash-bad'), false);
  assert.equal(cache.size, 1);

  const wrongModelStore = join(dir, 'wrong-model.ndjson');
  await writeRawStore(wrongModelStore, [{ _meta: validMeta({ model: 'other-model' }) }]);
  assert.equal((await readEmbeddingCache(embeddingConfig, wrongModelStore)).size, 0);
  assert.equal((await readEmbeddingCache(embeddingConfig, join(dir, 'missing.ndjson'))).size, 0);
});

test('validateVectorStoreMeta: 校验 chunk、dim、headingWeight 和 createdAt', () => {
  assert.doesNotThrow(() => validateVectorStoreMeta(validMeta(), embeddingConfig, 2));
  assert.throws(
    () => validateVectorStoreMeta(validMeta({ dim: 3 }), embeddingConfig, 2),
    /dim=3/,
  );
  assert.throws(
    () => validateVectorStoreMeta(validMeta({ chunkOverlap: 100 }), embeddingConfig),
    /chunkOverlap=100/,
  );
  assert.throws(
    () => validateVectorStoreMeta(validMeta({ headingWeight: -1 }), embeddingConfig),
    /headingWeight/,
  );
  assert.throws(
    () => validateVectorStoreMeta(validMeta({ createdAt: 'not-a-date' }), embeddingConfig),
    /createdAt/,
  );
});
