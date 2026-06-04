// test/library-api.test.ts
// -----------------------------------------------------------------------------
// 覆盖新的纯库接口：调用方显式传入 embed/chat，src 不负责 CLI 输入输出。
// -----------------------------------------------------------------------------

import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadDocuments } from '../src/ingestion/documents';
import { ingest } from '../src/ingestion/index';
import { query } from '../src/query/index';
import { createRetriever, tokenizeForKeyword } from '../src/query/retrieval';
import type { ChatFunction, EmbeddingConfig, LLMConfig } from '../src/types';

const embeddingConfig: EmbeddingConfig = {
  provider: 'lmstudio',
  baseURL: 'http://example.test/v1',
  apiKey: 'test',
  model: 'test-embedding',
};

const llmConfig: LLMConfig = {
  provider: 'lmstudio',
  baseURL: 'http://example.test/v1',
  apiKey: 'test',
  model: 'test-llm',
};

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tiny-rag-test-'));
}

test('query: 使用注入的 embed/chat 返回结构化结果', async () => {
  const dir = await makeTempDir();
  const vectorStore = join(dir, 'store.ndjson');
  await writeFile(
    vectorStore,
    [
      JSON.stringify({
        _meta: {
          version: 1,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dim: 2,
          chunkSize: 100,
          chunkOverlap: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      JSON.stringify({
        id: 'doc.md#0',
        source: 'doc.md',
        chunkIndex: 0,
        heading: 'Cache',
        content: 'Cache entries expire after 30 minutes.',
        hash: 'hash-1',
        embedding: [1, 0],
      }),
    ].join('\n') + '\n',
  );

  let chatCalled = false;
  let retrievedTiming:
    | {
        embeddingElapsedMs: number;
        searchElapsedMs: number;
        retrievalElapsedMs: number;
      }
    | undefined;
  const result = await query('cache ttl', {
    vectorStore,
    topK: 1,
    minScore: 0,
    perSourceLimit: 1,
    embeddingConfig,
    llmConfig,
    embed: async () => [[1, 0]],
    chat: async (messages) => {
      chatCalled = true;
      assert.match(messages[1]?.content ?? '', /Cache entries expire after 30 minutes/);
      return 'Cache entries expire after 30 minutes.[1]';
    },
    onRetrieved: ({ embeddingElapsedMs, searchElapsedMs, retrievalElapsedMs }) => {
      assert.equal(chatCalled, false);
      retrievedTiming = { embeddingElapsedMs, searchElapsedMs, retrievalElapsedMs };
    },
  });

  assert.equal(result.answer, 'Cache entries expire after 30 minutes.[1]');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].source, 'doc.md');
  assert.equal(result.noAnswerReason, undefined);
  assert.equal(result.embeddingElapsedMs, retrievedTiming?.embeddingElapsedMs);
  assert.equal(result.searchElapsedMs, retrievedTiming?.searchElapsedMs);
  assert.equal(result.retrievalElapsedMs, retrievedTiming?.retrievalElapsedMs);
  assert.equal(typeof result.generationElapsedMs, 'number');
});

test('query: 支持复用预加载 retriever', async () => {
  const dir = await makeTempDir();
  const vectorStore = join(dir, 'store.ndjson');
  await writeFile(
    vectorStore,
    [
      JSON.stringify({
        _meta: {
          version: 1,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dim: 2,
          chunkSize: 100,
          chunkOverlap: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      JSON.stringify({
        id: 'cache.md#0',
        source: 'cache.md',
        chunkIndex: 0,
        heading: 'Cache TTL',
        content: 'Cache entries expire after 30 minutes.',
        hash: 'hash-1',
        embedding: [1, 0],
      }),
    ].join('\n') + '\n',
  );

  const retriever = await createRetriever(embeddingConfig, {
    vectorStore,
    topK: 1,
    minScore: 0,
    perSourceLimit: 1,
  });
  const result = await query('cache ttl', {
    vectorStore,
    topK: 1,
    minScore: 0,
    perSourceLimit: 1,
    embeddingConfig,
    llmConfig,
    embed: async () => [[1, 0]],
    chat: async () => 'Cache entries expire after 30 minutes.[1]',
    retriever,
  });

  assert.equal(retriever.recordCount, 1);
  assert.equal(result.hits[0].source, 'cache.md');
  assert.equal(result.answer, 'Cache entries expire after 30 minutes.[1]');
});

test('query: 没有命中时不调用 chat', async () => {
  const dir = await makeTempDir();
  const vectorStore = join(dir, 'store.ndjson');
  await writeFile(
    vectorStore,
    [
      JSON.stringify({
        _meta: {
          version: 1,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dim: 2,
          chunkSize: 100,
          chunkOverlap: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      JSON.stringify({
        id: 'doc.md#0',
        source: 'doc.md',
        chunkIndex: 0,
        heading: 'Cache',
        content: 'Cache entries expire after 30 minutes.',
        hash: 'hash-1',
        embedding: [0, 1],
      }),
    ].join('\n') + '\n',
  );

  let chatCalled = false;
  const chat: ChatFunction = async () => {
    chatCalled = true;
    return '不应该调用';
  };

  const result = await query('cache ttl', {
    vectorStore,
    topK: 1,
    minScore: 0.9,
    perSourceLimit: 1,
    embeddingConfig,
    llmConfig,
    embed: async () => [[1, 0]],
    chat,
    prompt: {
      unknownAnswer: 'No matching context.',
    },
  });

  assert.equal(result.answer, 'No matching context.');
  assert.equal(result.noAnswerReason, 'no-hits');
  assert.equal(result.hits.length, 0);
  assert.equal(chatCalled, false);
});

test('query: 支持隐藏 candidates/context 大字段', async () => {
  const dir = await makeTempDir();
  const vectorStore = join(dir, 'store.ndjson');
  await writeFile(
    vectorStore,
    [
      JSON.stringify({
        _meta: {
          version: 1,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dim: 2,
          chunkSize: 100,
          chunkOverlap: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      JSON.stringify({
        id: 'cache.md#0',
        source: 'cache.md',
        chunkIndex: 0,
        heading: 'Cache TTL',
        content: 'Cache entries expire after 30 minutes.',
        hash: 'hash-1',
        embedding: [1, 0],
      }),
    ].join('\n') + '\n',
  );

  const result = await query('cache ttl', {
    vectorStore,
    topK: 1,
    minScore: 0,
    perSourceLimit: 1,
    embeddingConfig,
    llmConfig,
    embed: async () => [[1, 0]],
    chat: async () => 'Cache entries expire after 30 minutes.[1]',
    includeCandidates: false,
    includeContext: false,
  });

  assert.equal(result.candidates, undefined);
  assert.equal(result.context, undefined);
  assert.equal(result.hits.length, 1);
});

test('query: 空白问题直接拒绝且不调用 embed/chat', async () => {
  let embedCalled = false;
  let chatCalled = false;

  await assert.rejects(
    () =>
      query('   ', {
        embeddingConfig,
        llmConfig,
        embed: async () => {
          embedCalled = true;
          return [[1, 0]];
        },
        chat: async () => {
          chatCalled = true;
          return '不应该调用';
        },
      }),
    /未输入问题/,
  );

  assert.equal(embedCalled, false);
  assert.equal(chatCalled, false);
});

test('query: 支持自定义 buildMessages 和 stream token 回调', async () => {
  const dir = await makeTempDir();
  const vectorStore = join(dir, 'store.ndjson');
  await writeFile(
    vectorStore,
    [
      JSON.stringify({
        _meta: {
          version: 1,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dim: 2,
          chunkSize: 100,
          chunkOverlap: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      JSON.stringify({
        id: 'cache.md#0',
        source: 'cache.md',
        chunkIndex: 0,
        heading: 'Cache',
        content: 'Cache entries expire after 30 minutes.',
        hash: 'hash-1',
        embedding: [1, 0],
      }),
    ].join('\n') + '\n',
  );

  const tokens: string[] = [];
  const result = await query('cache ttl', {
    vectorStore,
    topK: 1,
    minScore: 0,
    perSourceLimit: 1,
    embeddingConfig,
    llmConfig,
    embed: async () => [[1, 0]],
    buildMessages: (context, question) => [
      { role: 'system', content: 'custom system' },
      { role: 'user', content: `${question}\n${context}` },
    ],
    stream: true,
    onToken: (token) => tokens.push(token),
    chat: async (messages, opts) => {
      assert.deepEqual(messages[0], { role: 'system', content: 'custom system' });
      assert.match(messages[1]?.content ?? '', /cache ttl/);
      opts?.onToken?.('A');
      opts?.onToken?.('B');
      return 'AB';
    },
  });

  assert.equal(result.answer, 'AB');
  assert.deepEqual(tokens, ['A', 'B']);
});

test('ingest: 使用注入的 embed 写入向量库并返回结果', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  await mkdir(documentsDir);
  await writeFile(join(documentsDir, 'cache.md'), '# Cache\n\nCache entries expire after 30 minutes.\n');

  const embeddedInputs: string[][] = [];
  const result = await ingest({
    documentsDir,
    vectorStore,
    chunkSize: 200,
    chunkOverlap: 20,
    embedBatchSize: 2,
    concurrency: 1,
    embeddingConfig,
    embed: async (inputs) => {
      embeddedInputs.push([...inputs]);
      return inputs.map(() => [1, 0]);
    },
  });

  assert.equal(result.docsCount, 1);
  assert.equal(result.chunksCount, 1);
  assert.equal(result.cachedCount, 0);
  assert.equal(result.embeddedCount, 1);

  const lines = (await readFile(vectorStore, 'utf-8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0])._meta.model, embeddingConfig.model);
  const record = JSON.parse(lines[1]);
  assert.deepEqual(record.embedding, [1, 0]);
  assert.deepEqual(record.keywordHeadingTerms, [['cache', 1]]);
  assert.ok(record.keywordContentTerms.some(([term]: [string, number]) => term === 'cache'));
  assert.match(embeddedInputs[0][0], /Cache\nCache\nCache entries expire after 30 minutes/);
});

test('ingest: 空文档目录返回 no-docs 且不调用 embed', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  await mkdir(documentsDir);

  let embedCalled = false;
  const result = await ingest({
    documentsDir,
    vectorStore,
    embeddingConfig,
    embed: async () => {
      embedCalled = true;
      return [];
    },
  });

  assert.equal(result.skippedReason, 'no-docs');
  assert.equal(result.docsCount, 0);
  assert.equal(result.chunksCount, 0);
  assert.equal(embedCalled, false);
});

test('ingest: 自定义切块返回空数组时返回 no-chunks', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  await mkdir(documentsDir);
  await writeFile(join(documentsDir, 'empty.md'), '# Empty\n');

  let embedCalled = false;
  const result = await ingest({
    documentsDir,
    vectorStore,
    embeddingConfig,
    embed: async () => {
      embedCalled = true;
      return [];
    },
    chunkDocument: () => [],
  });

  assert.equal(result.skippedReason, 'no-chunks');
  assert.equal(result.docsCount, 1);
  assert.equal(result.chunksCount, 0);
  assert.equal(embedCalled, false);
});

test('ingest: 复用旧向量缓存并跳过 embedding 请求', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  await mkdir(documentsDir);
  await writeFile(join(documentsDir, 'cache.md'), '# Cache\n\nCache entries expire after 30 minutes.\n');

  const first = await ingest({
    documentsDir,
    vectorStore,
    chunkSize: 200,
    chunkOverlap: 20,
    embeddingConfig,
    embed: async (inputs) => inputs.map(() => [3, 4]),
  });
  assert.equal(first.cachedCount, 0);
  assert.equal(first.embeddedCount, 1);

  let secondEmbedCalled = false;
  const second = await ingest({
    documentsDir,
    vectorStore,
    chunkSize: 200,
    chunkOverlap: 20,
    embeddingConfig,
    embed: async () => {
      secondEmbedCalled = true;
      return [[0, 1]];
    },
  });

  assert.equal(second.cachedCount, 1);
  assert.equal(second.embeddedCount, 0);
  assert.equal(second.skippedReason, 'unchanged');
  assert.equal(secondEmbedCalled, false);

  const record = JSON.parse((await readFile(vectorStore, 'utf-8')).trim().split('\n')[1]);
  assert.ok(Math.abs(record.embedding[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(record.embedding[1] - 0.8) < 1e-9);
});

test('ingest: 配置 intermediateDir 且内容变化时先清理旧中间态缓存', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  const intermediateDir = join(dir, 'intermediate');
  await mkdir(documentsDir);
  await mkdir(intermediateDir);
  await writeFile(join(documentsDir, 'cache.md'), '# Cache\n\nCache entries expire after 30 minutes.\n');

  await ingest({
    documentsDir,
    vectorStore,
    intermediateDir,
    chunkSize: 200,
    chunkOverlap: 20,
    embeddingConfig,
    embed: async (inputs) => inputs.map(() => [3, 4]),
  });

  await writeFile(join(intermediateDir, '0123456789abcdef.manifest.json'), '{}');
  await writeFile(join(intermediateDir, '0123456789abcdef.records.ndjson'), '{}\n');
  await writeFile(join(intermediateDir, '0123456789abcdef.embeddings.f32'), '');
  await writeFile(join(intermediateDir, 'keep.txt'), 'not a tiny-rag cache file');
  await writeFile(join(documentsDir, 'cache.md'), '# Cache\n\nCache entries expire after 45 minutes.\n');

  let embedCalled = false;
  const second = await ingest({
    documentsDir,
    vectorStore,
    intermediateDir,
    chunkSize: 200,
    chunkOverlap: 20,
    embeddingConfig,
    embed: async (inputs) => {
      embedCalled = true;
      return inputs.map(() => [0, 1]);
    },
  });

  assert.equal(second.cachedCount, 0);
  assert.equal(second.embeddedCount, 1);
  assert.equal(second.skippedReason, undefined);
  assert.equal(embedCalled, true);

  const cacheFiles = await readdir(intermediateDir);
  assert.equal(cacheFiles.includes('0123456789abcdef.manifest.json'), false);
  assert.equal(cacheFiles.includes('0123456789abcdef.records.ndjson'), false);
  assert.equal(cacheFiles.includes('0123456789abcdef.embeddings.f32'), false);
  assert.equal(cacheFiles.includes('keep.txt'), true);
  assert.equal(cacheFiles.filter((file) => file.endsWith('.manifest.json')).length, 1);
  assert.equal(cacheFiles.filter((file) => file.endsWith('.records.ndjson')).length, 1);
  assert.equal(cacheFiles.filter((file) => file.endsWith('.embeddings.f32')).length, 1);
});

test('ingest: embedding 返回数量不匹配时 fail-fast 且不写脏文件', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  await mkdir(documentsDir);
  await writeFile(join(documentsDir, 'cache.md'), '# Cache\n\nCache entries expire after 30 minutes.\n');

  await assert.rejects(
    () =>
      ingest({
        documentsDir,
        vectorStore,
        chunkSize: 200,
        chunkOverlap: 20,
        embeddingConfig,
        embed: async () => [],
      }),
    /embedding 返回数量不匹配/,
  );
  await assert.rejects(() => access(vectorStore));
});

test('ingest: 支持自定义 chunkDocument', async () => {
  const dir = await makeTempDir();
  const documentsDir = join(dir, 'docs');
  const vectorStore = join(dir, 'store.ndjson');
  await mkdir(documentsDir);
  await writeFile(join(documentsDir, 'cache.md'), '# Cache\n\nCache entries expire after 30 minutes.\n');

  await ingest({
    documentsDir,
    vectorStore,
    chunkSize: 200,
    chunkOverlap: 20,
    embeddingConfig,
    embed: async (inputs) => inputs.map(() => [1, 0]),
    chunkDocument: (doc, opts) => [
      {
        heading: 'Custom',
        content: `${doc.source}:${opts.chunkSize}:${opts.chunkOverlap}`,
      },
    ],
  });

  const lines = (await readFile(vectorStore, 'utf-8')).trim().split('\n');
  const record = JSON.parse(lines[1]);
  assert.equal(record.heading, 'Custom');
  assert.equal(record.content, 'cache.md:200:20');
});

test('loadDocuments: 支持自定义扩展名和 sourceRoot', async () => {
  const dir = await makeTempDir();
  const root = join(dir, 'workspace');
  const documentsDir = join(root, 'content');
  await mkdir(documentsDir, { recursive: true });
  await writeFile(join(documentsDir, 'alpha.md'), 'alpha');
  await writeFile(join(documentsDir, 'beta.text'), 'beta');
  await writeFile(join(documentsDir, 'skip.json'), '{"skip":true}');

  const docs = await loadDocuments(documentsDir, {
    sourceRoot: root,
    extensions: ['md', '.text'],
  });

  assert.deepEqual(
    docs.map((doc) => doc.source),
    ['content/alpha.md', 'content/beta.text'],
  );
  assert.deepEqual(
    docs.map((doc) => doc.content),
    ['alpha', 'beta'],
  );
});

test('loadDocuments: 支持按 source 排除和自定义过滤', async () => {
  const dir = await makeTempDir();
  await mkdir(join(dir, 'nested'), { recursive: true });
  await writeFile(join(dir, 'index.md'), 'directory map');
  await writeFile(join(dir, 'keep.md'), 'keep');
  await writeFile(join(dir, 'nested', 'draft.md'), 'draft');

  const docs = await loadDocuments(dir, {
    excludeSources: ['index.md'],
    filterDocument: (doc) => !doc.source.endsWith('/draft.md'),
  });

  assert.deepEqual(
    docs.map((doc) => doc.source),
    ['keep.md'],
  );
});

test('loadDocuments: 并发读取仍保持递归排序后的输出顺序', async () => {
  const dir = await makeTempDir();
  await mkdir(join(dir, 'a'), { recursive: true });
  await mkdir(join(dir, 'b'), { recursive: true });
  await writeFile(join(dir, 'z.md'), 'z');
  await writeFile(join(dir, 'a', 'b.md'), 'ab');
  await writeFile(join(dir, 'a', 'a.md'), 'aa');
  await writeFile(join(dir, 'b', 'a.md'), 'ba');

  const docs = await loadDocuments(dir);

  assert.deepEqual(
    docs.map((doc) => `${doc.source}:${doc.content}`),
    ['a/a.md:aa', 'a/b.md:ab', 'b/a.md:ba', 'z.md:z'],
  );
});

test('query: keyword fusion 可以把精确关键词命中的 chunk 提到前面', async () => {
  const dir = await makeTempDir();
  const vectorStore = join(dir, 'store.ndjson');
  await writeFile(
    vectorStore,
    [
      JSON.stringify({
        _meta: {
          version: 1,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dim: 2,
          chunkSize: 100,
          chunkOverlap: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      JSON.stringify({
        id: 'overview.md#0',
        source: 'overview.md',
        chunkIndex: 0,
        heading: 'Overview',
        content: 'General system overview.',
        hash: 'hash-1',
        embedding: [0.95, 0],
      }),
      JSON.stringify({
        id: 'cache.md#0',
        source: 'cache.md',
        chunkIndex: 0,
        heading: 'Cache TTL',
        content: 'Cache entries expire after 30 minutes.',
        hash: 'hash-2',
        embedding: [0.2, 0],
      }),
    ].join('\n') + '\n',
  );

  const result = await query('cache ttl', {
    vectorStore,
    topK: 1,
    minScore: 0,
    perSourceLimit: 1,
    keywordWeight: 0.8,
    keywordHeadingWeight: 2,
    embeddingConfig,
    llmConfig,
    embed: async () => [[1, 0]],
    chat: async () => 'Cache entries expire after 30 minutes.[1]',
  });

  assert.equal(result.hits[0].source, 'cache.md');
  assert.ok((result.hits[0].keywordScore ?? 0) > 0);
  assert.ok((result.hits[0].score ?? 0) > (result.hits[0].vectorScore ?? 0));
});

test('tokenizeForKeyword: 中文短语使用 bigram，保留英文数字 token', () => {
  assert.deepEqual(tokenizeForKeyword('如何配置缓存 ABC-123'), [
    '如何',
    '何配',
    '配置',
    '置缓',
    '缓存',
    'abc',
    '123',
  ]);
});
