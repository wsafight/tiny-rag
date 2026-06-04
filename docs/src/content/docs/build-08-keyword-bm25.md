---
title: "B08: 关键词分词与 BM25"
description: 为纯向量检索补充字面匹配信号，实现中文 bigram 分词和 BM25 打分。
---

纯向量检索抓语义，但对专有名词、编号、中文短词的字面匹配不敏感。这一章先实现关键词分词和 BM25 打分，下一章再把它们接入检索器。

## 先理解：字面命中解决什么问题

向量检索回答的是“这两段话语义上像不像”。它适合处理同义改写，比如“怎么退货”和“售后规则”。但它不一定擅长订单号、产品名、错误码、短中文词这些必须字面命中的问题。

关键词检索回答的是“查询词有没有明确出现在文本里”。BM25 会进一步考虑词频、文档长度和词的稀有程度。它不懂深层语义，但对精确词非常有用。

这章只产出一个 `keyword.ts`，里面有三件事：

- `tokenize()`：把文本切成关键词。
- `buildKeywordIndex()`：统计每条 chunk 的词频和全局文档频率。
- `scoreBm25()`：给某条 chunk 算关键词分。

## 关键词分词

中文没有空格，简单按空白切不出词。这里用一个不依赖第三方分词库的策略：英文 / 数字按连续字母数字切，中文按 **bigram**（相邻两字）切。

```ts
// keyword.ts
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[\u3000\s]+/g, ' ').trim();
  if (!normalized) return [];

  const tokens: string[] = [];
  const matches = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
  for (const part of matches) {
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      if (part.length === 1) tokens.push(part);
      else for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2));
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}
```

`生日券怎么用` 会切成 `生日, 日券, 券怎, 怎么, 么用`。这不是精确分词，但对小项目足够稳定，且零依赖。

## BM25 索引

BM25 衡量一个查询词对一篇文档的重要性，综合考虑：词频、文档长度、以及该词在语料中的稀有度（IDF）。先预处理语料，统计每条 chunk 的词频和文档频率：

```ts
// keyword.ts（续）
import type { VectorStoreRecord } from './types';

export interface KeywordIndex {
  docs: Array<{ tf: Map<string, number>; len: number }>;
  df: Map<string, number>;
  avgLen: number;
}

export function buildKeywordIndex(records: readonly VectorStoreRecord[]): KeywordIndex {
  const df = new Map<string, number>();
  const docs = records.map((r) => {
    const tokens = tokenize(`${r.heading} ${r.content}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return { tf, len: tokens.length };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLen };
}
```

## BM25 打分

打分用标准 BM25 公式（`k1 = 1.2`，`b = 0.75`）：

```ts
// keyword.ts（续）
export function scoreBm25(index: KeywordIndex, docIdx: number, queryTerms: readonly string[]): number {
  const k1 = 1.2;
  const b = 0.75;
  const N = index.docs.length;
  const doc = index.docs[docIdx];
  let score = 0;
  for (const term of queryTerms) {
    const f = doc.tf.get(term) ?? 0;
    if (f === 0) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const denom = f + k1 * (1 - b + (b * doc.len) / index.avgLen);
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return score;
}
```

## 验证

先用一个小例子确认分词和 BM25 能跑：

```ts
// main.ts
import { buildKeywordIndex, scoreBm25, tokenize } from './keyword';
import type { VectorStoreRecord } from './types';

const records: VectorStoreRecord[] = [
  {
    id: 'faq.md#0',
    source: 'faq.md',
    chunkIndex: 0,
    heading: '售后规则',
    content: '7 天无理由退货。',
    embedding: [],
  },
  {
    id: 'faq.md#1',
    source: 'faq.md',
    chunkIndex: 1,
    heading: '订单问题',
    content: '订单支付后 10 分钟内可取消。',
    embedding: [],
  },
];

const index = buildKeywordIndex(records);
const terms = tokenize('7 天能退货吗？');
console.log(terms.join(', '));
console.log(scoreBm25(index, 0, terms).toFixed(4));
console.log(scoreBm25(index, 1, terms).toFixed(4));
```

含「退货」字面词的记录应该得到更高 BM25 分。下一章把这个分数接入向量检索器，形成混合排序。
