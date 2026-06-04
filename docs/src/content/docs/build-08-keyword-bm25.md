---
title: "B08: 关键词分词与 BM25"
description: 为向量检索补上字面匹配信号，解释中文 bigram、词频统计和 BM25 分数如何协作。
---

纯向量检索抓语义，但对专有名词、编号、中文短词的字面匹配不敏感。这一章先实现关键词分词和 BM25 打分，下一章再把它们接入检索器。

很多 RAG 问题不是“模型不懂语义”，而是“检索没有把关键字当回事”。例如产品型号、错误码、订单状态、菜单名，答案往往依赖精确字面命中。BM25 不是为了取代向量检索，而是给语义检索补一条更硬的信号。

:::note[本章产出]
- **前置**：读完 `B07`。本章是独立的算法小节，不依赖前面跑出的向量库，可以单独验证。
- **产出**：一份 `keyword.ts`，含 `tokenize()`（分词）、`buildKeywordIndex()`（统计词频/文档频率）、`scoreBm25()`（打分）。
- **核心收获**：理解“语义相似”和“字面命中”是两种互补信号，以及 BM25 大致在算什么。
:::

> BM25 = 一种经典的关键词相关性打分算法，综合考虑词频、文档长度和词的稀有程度。

## 先理解：字面命中解决什么问题

向量检索回答的是“这两段话语义上像不像”。它适合处理同义改写，比如“怎么退货”和“售后规则”。但它不一定擅长订单号、产品名、错误码、短中文词这些必须字面命中的问题。

关键词检索回答的是“查询词有没有明确出现在文本里”。BM25 会进一步考虑词频、文档长度和词的稀有程度。它不懂深层语义，但对精确词非常有用。

这章只产出一个 `keyword.ts`，里面有三件事：

- `tokenize()`：把文本切成关键词。
- `buildKeywordIndex()`：统计每条 chunk 的词频和全局文档频率。
- `scoreBm25()`：给某条 chunk 算关键词分。

可以把向量检索理解成“语义相似”，把 BM25 理解成“词项证据”。前者对同义表达友好，后者对精确字段友好。真实查询通常两者都需要，所以这一章先把关键词分数单独做出来，下一章再融合。

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

:::tip[为什么中文用 bigram（相邻两字）]
中文不像英文有空格分词。专业分词库能切出“生日券 / 怎么 / 用”，但要引入依赖和词典。bigram 是个零依赖的折中：把连续汉字按“相邻两字”滑窗切开。它会产生一些不自然的片段（如 `日券`），但只要查询和文档用同一套规则，字面命中依然能对齐。生产环境想要更准，可以把 `tokenize()` 换成专门分词库，后面的 BM25 逻辑完全不用改。
:::

bigram 的优点是简单稳定，缺点是会产生一些不自然的词片段。对学习项目来说，这个取舍可以接受：这里要的是可解释的字面信号，而不是最佳中文分词效果。生产场景可以把 `tokenize()` 替换成专门分词库，后面的 BM25 逻辑不用改。

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

这里把 `heading` 和 `content` 放在一起分词，是因为标题往往概括了 chunk 的主题。tiny-rag 的真实实现还会给标题词更高权重，让“取消订单”这种标题命中在排序里更有影响。

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

BM25 的直觉是：一个词在当前 chunk 里出现越多越重要，但增长会逐渐变慢；一个词在全库里越少见，越能区分文档；chunk 太长时，词频需要被长度校正。它不是语义模型，而是一个非常实用的相关性统计。

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

这一章结束后，检索系统有了第二种信号。它还没有改变最终排序，但已经为混合检索打好基础：同一个问题既可以问“语义上像不像”，也可以问“关键字是否真的出现”。

## 本章小结

- 关键词检索回答的是“查询词有没有明确出现在文本里”，和向量检索的“语义像不像”互补。
- `tokenize()`：英文/数字按连续字母数字切，中文按 **bigram** 切，零依赖。
- BM25 的直觉：词在当前 chunk 出现越多越重要（但增长递减），在全库越少见越能区分（IDF），chunk 太长要做长度校正。
- 本章只产出分数，**还没改排序**，下一章才把它接进检索器。

:::note[下一章：B09 混合检索与同源去重]
下一章把向量分数和 BM25 分数按权重融合排序，并用 `selectDiverseHits()` 限制单个文件占满 TopK，让上下文证据更多样。检索阶段到此收尾。
:::
