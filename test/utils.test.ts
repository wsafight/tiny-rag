// test/utils.test.ts
// -----------------------------------------------------------------------------
// 使用 Node 内置 test runner 覆盖 src/utils.ts 的关键工具函数。
// 跑测：pnpm test
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dot,
  fail,
  normalize,
  normalizeToFloat32,
  hasValidEmbedding,
  invariant,
  runWithConcurrency,
} from '../src/utils/index';
import {
  envBoolean,
  envChoice,
  envInteger,
  envNumber,
  envString,
} from '../runtime/env';
import { splitByLength, splitSemantic } from '../src/ingestion/chunking';
import {
  buildChunkRecords,
  buildEmbeddingText,
} from '../src/ingestion/ingest';
import { normalizeDocumentExtensions } from '../src/ingestion/documents';
import { VECTOR_STORE_SCHEMA_VERSION } from '../src/constants/index';
import {
  resolveRankingOptions,
  selectDiverseHits,
} from '../src/query/retrieval';
import {
  buildContext,
  buildMessages,
  resolvePromptOptions,
} from '../src/query/prompt';

// ----------------------------- dot -----------------------------

test('dot: 普通向量', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 4 + 10 + 18);
});

test('dot: 空向量为 0', () => {
  assert.equal(dot([], []), 0);
});

test('dot: 向量长度不一致应抛错', () => {
  assert.throws(() => dot([1, 2], [1]), /长度不一致/);
});

test('dot: 归一化向量的点积等于 cosine', () => {
  const a = normalize([1, 0, 0]);
  const b = normalize([1, 0, 0]);
  assert.ok(Math.abs(dot(a, b) - 1) < 1e-9);
  const c = normalize([0, 1, 0]);
  assert.ok(Math.abs(dot(a, c)) < 1e-9);
});

// ----------------------------- normalize -----------------------------

test('normalize: L2 模长为 1', () => {
  const v = normalize([3, 4]);
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2);
  assert.ok(Math.abs(len - 1) < 1e-9);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(v[1] - 0.8) < 1e-9);
});

test('normalize: 零向量原样返回（拷贝）', () => {
  const input = [0, 0, 0];
  const out = normalize(input);
  assert.deepEqual(out, [0, 0, 0]);
  assert.notEqual(out, input, '应返回新数组而非原引用');
});

test('normalizeToFloat32: 返回 typed array 并保持零向量拷贝语义', () => {
  const v = normalizeToFloat32([3, 4]);
  assert.ok(v instanceof Float32Array);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(v[1] - 0.8) < 1e-6);

  const zero = normalizeToFloat32([0, 0]);
  assert.ok(zero instanceof Float32Array);
  assert.deepEqual([...zero], [0, 0]);
});

// ----------------------------- splitByLength -----------------------------

test('splitByLength: 短文本不切', () => {
  assert.deepEqual(splitByLength('hello', 10, 2), ['hello']);
});

test('splitByLength: 长文本按 size 切并保留 overlap', () => {
  const text = 'abcdefghij'; // length 10
  const out = splitByLength(text, 4, 1);
  // step = 3, 起点 0,3,6 -> 'abcd'(0..4), 'defg'(3..7), 'ghij'(6..10)
  // end===text.length 时 break，所以恰好 3 块
  assert.deepEqual(out, ['abcd', 'defg', 'ghij']);
});

test('splitByLength: overlap >= size 应抛错', () => {
  assert.throws(() => splitByLength('abcdef', 4, 4), /overlap/);
  assert.throws(() => splitByLength('abcdef', 4, 5), /overlap/);
});

test('splitByLength: size <= 0 应抛错', () => {
  assert.throws(() => splitByLength('abc', 0, 0), /size/);
  assert.throws(() => splitByLength('abc', -1, 0), /size/);
});

// ----------------------------- splitSemantic -----------------------------

test('splitSemantic: 按标题维护多级 heading 路径', () => {
  const md = `# 一级
段落 A

## 二级 a
段落 B

## 二级 b
段落 C

# 另一个一级
段落 D`;
  const chunks = splitSemantic(md, 200, 20);
  const headings = chunks.map((c) => c.heading);
  assert.deepEqual(headings, [
    '一级',
    '一级 > 二级 a',
    '一级 > 二级 b',
    '另一个一级',
  ]);
  assert.equal(chunks[0].content, '段落 A');
  assert.equal(chunks[1].content, '段落 B');
});

test('splitSemantic: 空字符串返回空数组', () => {
  assert.deepEqual(splitSemantic('', 100, 10), []);
});

test('splitSemantic: 段落聚合到 size 以内', () => {
  // 三段都很短，应该被聚合在一起
  const md = `# H
aaa

bbb

ccc`;
  const chunks = splitSemantic(md, 200, 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'H');
  assert.ok(chunks[0].content.includes('aaa'));
  assert.ok(chunks[0].content.includes('bbb'));
  assert.ok(chunks[0].content.includes('ccc'));
});

test('splitSemantic: 单段超长时回退到 splitByLength', () => {
  const long = 'x'.repeat(100);
  const md = `# H\n${long}`;
  const chunks = splitSemantic(md, 30, 5);
  // 期望被切成多块，且每块长度 <= 30
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.content.length <= 30));
  assert.ok(chunks.every((c) => c.heading === 'H'));
});

test('splitSemantic: 没有标题的纯文本也能切', () => {
  const text = '第一段内容\n\n第二段内容\n\n第三段内容';
  const chunks = splitSemantic(text, 200, 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, '');
});

test('splitSemantic: heading 同级时正确替换栈顶', () => {
  const md = `## A
段落 1

## B
段落 2`;
  const chunks = splitSemantic(md, 200, 10);
  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['A', 'B'],
  );
});

// ----------------------------- VECTOR_STORE_SCHEMA_VERSION -----------------------------

test('VECTOR_STORE_SCHEMA_VERSION: 是合法的正整数', () => {
  assert.equal(typeof VECTOR_STORE_SCHEMA_VERSION, 'number');
  assert.ok(Number.isInteger(VECTOR_STORE_SCHEMA_VERSION) && VECTOR_STORE_SCHEMA_VERSION >= 1);
});

// ----------------------------- invariant -----------------------------

test('invariant: condition 为 true 时抛错', () => {
  const condition = true;
  assert.throws(() => invariant(condition, 'failed'), /failed/);
  assert.doesNotThrow(() => invariant(false, 'failed'));
});

test('fail: 直接抛错并返回 never', () => {
  assert.throws(() => fail('failed'), /failed/);
});

// ----------------------------- hasValidEmbedding -----------------------------

test('hasValidEmbedding: 区分合法与非法值', () => {
  assert.equal(hasValidEmbedding([0.1, 0.2, 0.3]), true);
  assert.equal(hasValidEmbedding([]), false);
  assert.equal(hasValidEmbedding(null), false);
  assert.equal(hasValidEmbedding(undefined), false);
  assert.equal(hasValidEmbedding('abc'), false);
  assert.equal(hasValidEmbedding({ length: 3 }), false);
  assert.equal(hasValidEmbedding([0.1, Number.NaN]), false);
  assert.equal(hasValidEmbedding([0.1, Infinity]), false);
  assert.equal(hasValidEmbedding([0.1, 0.2], 3), false);
  assert.equal(hasValidEmbedding([0.1, 0.2], 2), true);
});

// ----------------------------- env helpers -----------------------------

test('envString: 未配置或空字符串使用默认值', () => {
  assert.equal(envString({}, 'TINY_RAG_TEST_STRING', 'fallback'), 'fallback');
  assert.equal(
    envString({ TINY_RAG_TEST_STRING: '' }, 'TINY_RAG_TEST_STRING', 'fallback'),
    'fallback',
  );
  assert.equal(
    envString({ TINY_RAG_TEST_STRING: 'value' }, 'TINY_RAG_TEST_STRING', 'fallback'),
    'value',
  );
});

test('envChoice: 读取枚举并转小写', () => {
  assert.equal(
    envChoice(
      { TINY_RAG_TEST_CHOICE: 'OpenAI' },
      'TINY_RAG_TEST_CHOICE',
      ['openai', 'ollama'],
      'ollama',
    ),
    'openai',
  );
  assert.throws(
    () =>
      envChoice(
        { TINY_RAG_TEST_CHOICE: 'bad' },
        'TINY_RAG_TEST_CHOICE',
        ['openai', 'ollama'],
        'ollama',
      ),
    /必须是/,
  );
});

test('envNumber: 校验数字范围', () => {
  assert.equal(
    envNumber({ TINY_RAG_TEST_NUMBER: '0.3' }, 'TINY_RAG_TEST_NUMBER', 0, {
      min: 0,
      max: 1,
    }),
    0.3,
  );
  assert.throws(
    () => envNumber({ TINY_RAG_TEST_NUMBER: 'abc' }, 'TINY_RAG_TEST_NUMBER', 0),
    /必须是数字/,
  );
  assert.throws(
    () => envNumber({ TINY_RAG_TEST_NUMBER: '2' }, 'TINY_RAG_TEST_NUMBER', 0, { max: 1 }),
    /必须 <= 1/,
  );
});

test('envInteger: 必须是整数', () => {
  assert.equal(
    envInteger({ TINY_RAG_TEST_INTEGER: '4' }, 'TINY_RAG_TEST_INTEGER', 1, { min: 1 }),
    4,
  );
  assert.throws(
    () => envInteger({ TINY_RAG_TEST_INTEGER: '1.5' }, 'TINY_RAG_TEST_INTEGER', 1),
    /必须是整数/,
  );
});

test('envBoolean: 支持常见开关写法', () => {
  assert.equal(
    envBoolean({ TINY_RAG_TEST_BOOLEAN: 'off' }, 'TINY_RAG_TEST_BOOLEAN', true),
    false,
  );
  assert.equal(
    envBoolean({ TINY_RAG_TEST_BOOLEAN: 'yes' }, 'TINY_RAG_TEST_BOOLEAN', false),
    true,
  );
  assert.throws(
    () => envBoolean({ TINY_RAG_TEST_BOOLEAN: 'maybe' }, 'TINY_RAG_TEST_BOOLEAN', true),
    /必须是/,
  );
});

// ----------------------------- prompt helpers -----------------------------

test('resolvePromptOptions/buildMessages: 默认提示词与自定义标签', () => {
  const defaults = resolvePromptOptions({ unknownAnswer: '不知道' });
  assert.match(defaults.systemPrompt, /不知道/);
  assert.equal(defaults.contextLabel, '参考内容');
  assert.equal(defaults.questionLabel, '问题');

  const messages = buildMessages('context text', 'question text', {
    systemPrompt: 'system',
    contextLabel: 'CTX',
    questionLabel: 'Q',
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'CTX：\ncontext text\n\nQ：\nquestion text' },
  ]);
});

test('buildContext: 带编号、source、heading，空 heading 时不输出 heading 行', () => {
  const context = buildContext([
    { source: 'a.md', heading: 'H', content: 'A content' },
    { source: 'b.md', heading: '', content: 'B content' },
  ]);

  assert.match(context, /\[1\] source=a\.md\nheading=H\nA content/);
  assert.match(context, /\[2\] source=b\.md\nB content/);
  assert.doesNotMatch(context, /\[2\] source=b\.md\nheading=/);
});

// ----------------------------- ranking/document helpers -----------------------------

test('resolveRankingOptions: 默认值和范围校验', () => {
  assert.deepEqual(resolveRankingOptions(), {
    topK: 4,
    minScore: 0,
    perSourceLimit: 2,
    keywordWeight: 0.3,
    keywordHeadingWeight: 2,
  });
  assert.throws(() => resolveRankingOptions({ topK: 0 }), /topK/);
  assert.throws(() => resolveRankingOptions({ minScore: 2 }), /minScore/);
  assert.throws(() => resolveRankingOptions({ keywordWeight: -0.1 }), /keywordWeight/);
  assert.throws(
    () => resolveRankingOptions({ keywordHeadingWeight: -1 }),
    /keywordHeadingWeight/,
  );
});

test('normalizeDocumentExtensions: 去重、补点、转小写并拒绝空列表', () => {
  assert.deepEqual(normalizeDocumentExtensions([' MD ', '.txt', 'md', '']), ['.md', '.txt']);
  assert.throws(() => normalizeDocumentExtensions([' ', '']), /documentExtensions/);
});

test('buildEmbeddingText: 按 headingWeight 重复标题并处理空标题', () => {
  assert.equal(buildEmbeddingText(' Cache ', ' content ', 2.8), 'Cache\nCache\ncontent');
  assert.equal(buildEmbeddingText('Cache', 'content', 0), 'content');
  assert.equal(buildEmbeddingText('', ' content ', 3), 'content');
});

test('buildChunkRecords: 生成稳定 id/hash/keyword stats 并支持自定义 chunkDocument', () => {
  const records = buildChunkRecords(
    [{ source: 'doc.md', content: '# Cache\n\nCache ttl.' }],
    {
      chunkSize: 100,
      chunkOverlap: 10,
      headingWeight: 1,
      chunkDocument: () => [
        { heading: 'Cache', content: 'Cache ttl.' },
        { heading: '', content: 'Second chunk.' },
      ],
    },
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'doc.md#0');
  assert.equal(records[1].id, 'doc.md#1');
  assert.equal(records[0].embeddingText, 'Cache\nCache ttl.');
  assert.match(records[0].hash, /^[0-9a-f]{40}$/);
  assert.notEqual(records[0].hash, records[1].hash);
  assert.deepEqual(records[0].keywordHeadingTerms, [['cache', 1]]);
  assert.ok(records[0].keywordContentTerms?.some(([term]) => term === 'cache'));
});

// ----------------------------- runWithConcurrency -----------------------------

test('runWithConcurrency: 顺序对齐 + 全部完成', async () => {
  const tasks = [10, 30, 5, 20].map((ms, i) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return i * 2;
  });
  const out = await runWithConcurrency(tasks, 2);
  assert.deepEqual(out, [0, 2, 4, 6]);
});

test('runWithConcurrency: limit <= 0 视为 1', async () => {
  const tasks = [async () => 1, async () => 2];
  const out = await runWithConcurrency(tasks, 0);
  assert.deepEqual(out, [1, 2]);
});

test('runWithConcurrency: 空任务列表返回空数组', async () => {
  const out = await runWithConcurrency([], 4);
  assert.deepEqual(out, []);
});

// ----------------------------- selectDiverseHits -----------------------------

test('selectDiverseHits: 同一 source 不超过 perSourceLimit', () => {
  const hits = [
    { source: 'a.md', score: 0.9 },
    { source: 'a.md', score: 0.85 },
    { source: 'a.md', score: 0.8 },
    { source: 'b.md', score: 0.7 },
    { source: 'c.md', score: 0.6 },
  ];
  const out = selectDiverseHits(hits, { perSourceLimit: 2, maxTotal: 4 });
  // a.md 只允许 2 条；最终顺序保持原顺序
  assert.deepEqual(
    out.map((h) => `${h.source}:${h.score}`),
    ['a.md:0.9', 'a.md:0.85', 'b.md:0.7', 'c.md:0.6'],
  );
});

test('selectDiverseHits: maxTotal 截断', () => {
  const hits = [
    { source: 'a.md', score: 0.9 },
    { source: 'b.md', score: 0.8 },
    { source: 'c.md', score: 0.7 },
    { source: 'd.md', score: 0.6 },
  ];
  const out = selectDiverseHits(hits, { perSourceLimit: 2, maxTotal: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'a.md');
  assert.equal(out[1].source, 'b.md');
});

test('selectDiverseHits: 默认参数仍可正常工作', () => {
  const hits = [
    { source: 'a.md', score: 0.9 },
    { source: 'a.md', score: 0.85 },
    { source: 'a.md', score: 0.8 },
  ];
  const out = selectDiverseHits(hits);
  // 默认 perSourceLimit=2 -> 只保留前 2 条
  assert.equal(out.length, 2);
});
