---
title: "B08: 关键词分词与 BM25"
description: 为向量检索补上字面匹配信号，解释中文 bigram、词频统计和 BM25 分数如何协作。
---

纯向量检索抓语义，但对专有名词、编号、中文短词的字面匹配不敏感。这一章先实现关键词分词和 BM25 打分，下一章再把它们接入检索器。

很多 RAG 问题不是“模型不懂语义”，而是“检索没有把关键字当回事”。例如产品型号、错误码、订单状态、菜单名，答案往往依赖精确字面命中。BM25 不是为了取代向量检索，而是给语义检索补一条更硬的信号。

`B01 > B02 > B03 > B04 > B05 > B06 | B07 > [ B08 ] B09 > B10`

> *"向量抓语义，BM25 抓字面。"* —— 两种互补信号，缺一种就会漏掉一类问题。
>
> **查询阶段**：这一章先单独造出 BM25 关键词分数，下一章再融合进检索器。

:::note[本章产出]
- **前置**：读完 `B07`。本章是独立的算法小节，不依赖前面跑出的向量库，可以单独验证。
- **产出**：一份 `keyword.ts`，含 `tokenize()`（分词）、`buildKeywordIndex()`（统计词频/文档频率）、`scoreBm25()`（打分）。
- **核心收获**：理解“语义相似”和“字面命中”是两种互补信号，以及 BM25 大致在算什么。
:::

## 问题

向量检索回答的是“这两段话语义上像不像”，它适合同义改写——“怎么退货”能召回“售后规则”。可一旦用户问的是订单号 `SO-20241001`、产品型号 `X-200`、错误码 `E50` 或某个短中文词，语义相似就帮不上忙了：这些词必须**字面命中**，而向量空间里它们和一堆近义内容挤在一起，分数未必拉得开。

关键词检索回答的是“查询词有没有明确出现在文本里”。BM25 会进一步考虑词频、文档长度和词的稀有程度。它不懂深层语义，但对精确词非常有用。它的全称是一种经典的关键词相关性打分算法，综合考虑词频、文档长度和词的稀有程度。

## 解决方案

这章只产出一个 `keyword.ts`，里面有三件事，串成一条从文本到分数的流水：

```text
chunk 文本（heading + content）
  → tokenize()        切成关键词（英文按词、中文按 bigram）
  → buildKeywordIndex() 统计每条 chunk 的词频 + 全局文档频率
查询词
  → tokenize()        用同一套规则切词
  → scoreBm25()       逐条 chunk 算 BM25 关键词分
```

- `tokenize()`：把文本切成关键词。
- `buildKeywordIndex()`：统计每条 chunk 的词频和全局文档频率。
- `scoreBm25()`：给某条 chunk 算关键词分。

可以把向量检索理解成“语义相似”，把 BM25 理解成“词项证据”。前者对同义表达友好，后者对精确字段友好。真实查询通常两者都需要，所以这一章先把关键词分数单独做出来，下一章再融合。

核心洞察是——**只要查询和文档用同一套分词规则，字面命中就能精确对齐；BM25 不理解语义，却恰好补上了向量检索最不擅长的精确词信号**。

## 工作原理

### 1. 关键词分词

中文没有空格，简单按空白切不出词。这里用一个不依赖第三方分词库的策略：英文 / 数字按连续字母数字切，中文按 **bigram**（相邻两字）切。

```ts
// keyword.ts
export function tokenize(text: string): string[] {
  // 统一大小写和空白，确保查询和文档使用完全相同的分词规则。
  const normalized = text.toLowerCase().replace(/[\u3000\s]+/g, ' ').trim();
  if (!normalized) return [];

  const tokens: string[] = [];
  // 连续中文作为一段，连续英文/数字作为一段；标点会被自然跳过。
  const matches = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
  for (const part of matches) {
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      // 单个汉字保留原样；多个汉字用 bigram 滑窗切成相邻两字。
      if (part.length === 1) tokens.push(part);
      else for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2));
    } else {
      // 英文和数字已经是连续 token，直接加入。
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

### 2. BM25 索引

BM25 衡量一个查询词对一篇文档的重要性，综合考虑：词频、文档长度、以及该词在语料中的稀有度（IDF）。先预处理语料，统计每条 chunk 的词频和文档频率：

```ts
// keyword.ts（续）
import type { VectorStoreRecord } from './types';

export interface KeywordIndex {
  /** 每条 chunk 的词频表和 token 总数。 */
  docs: Array<{ tf: Map<string, number>; len: number }>;
  /** 文档频率：某个 term 出现在多少条 chunk 里。 */
  df: Map<string, number>;
  /** 平均 chunk 长度，用于 BM25 的长度校正。 */
  avgLen: number;
}

export function buildKeywordIndex(records: readonly VectorStoreRecord[]): KeywordIndex {
  const df = new Map<string, number>();
  const docs = records.map((r) => {
    // 标题和正文一起分词，让标题里的主题词也能贡献关键词分。
    const tokens = tokenize(`${r.heading} ${r.content}`);
    const tf = new Map<string, number>();
    // tf 统计当前 chunk 内每个 term 出现几次。
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    // df 每个 chunk 只计一次，所以遍历 tf.keys() 而不是 tokens。
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return { tf, len: tokens.length };
  });
  // 空语料时用 1 做分母保护，避免 NaN 继续流入打分。
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLen };
}
```

这里把 `heading` 和 `content` 放在一起分词，是因为标题往往概括了 chunk 的主题。tiny-rag 的真实实现还会给标题词更高权重，让“取消订单”这种标题命中在排序里更有影响。

### 3. BM25 打分

打分用标准 BM25 公式（`k1 = 1.2`，`b = 0.75`）：

```ts
// keyword.ts（续）
export function scoreBm25(index: KeywordIndex, docIdx: number, queryTerms: readonly string[]): number {
  // k1 控制词频增长的饱和速度，b 控制文档长度校正强度。
  const k1 = 1.2;
  const b = 0.75;
  const N = index.docs.length;
  const doc = index.docs[docIdx];
  let score = 0;
  for (const term of queryTerms) {
    // 当前文档没有这个查询词，就没有贡献。
    const f = doc.tf.get(term) ?? 0;
    if (f === 0) continue;
    // df 越小，说明 term 越稀有，IDF 贡献越大。
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    // 长文档里出现一次词不如短文档里出现一次词有区分度，所以要做长度校正。
    const denom = f + k1 * (1 - b + (b * doc.len) / index.avgLen);
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return score;
}
```

BM25 的直觉是：一个词在当前 chunk 里出现越多越重要，但增长会逐渐变慢；一个词在全库里越少见，越能区分文档；chunk 太长时，词频需要被长度校正。它不是语义模型，而是一个非常实用的相关性统计。

### 4. 验证

先用一个小例子确认分词和 BM25 能跑：

```ts
// main.ts
import { buildKeywordIndex, scoreBm25, tokenize } from './keyword';
import type { VectorStoreRecord } from './types';

const records: VectorStoreRecord[] = [
  {
    // 第一条包含“退货”字面词，查询相关时 BM25 应该更高。
    id: 'faq.md#0',
    source: 'faq.md',
    chunkIndex: 0,
    heading: '售后规则',
    content: '7 天无理由退货。',
    embedding: [],
  },
  {
    // 第二条语义上也许相关，但没有“退货”字面词。
    id: 'faq.md#1',
    source: 'faq.md',
    chunkIndex: 1,
    heading: '订单问题',
    content: '订单支付后 10 分钟内可取消。',
    embedding: [],
  },
];

const index = buildKeywordIndex(records);
// 查询和文档使用同一个 tokenize()，字面命中才能对齐。
const terms = tokenize('7 天能退货吗？');
console.log(terms.join(', '));
console.log(scoreBm25(index, 0, terms).toFixed(4));
console.log(scoreBm25(index, 1, terms).toFixed(4));
```

含「退货」字面词的记录应该得到更高 BM25 分。下一章把这个分数接入向量检索器，形成混合排序。

这一章结束后，检索系统有了第二种信号。它还没有改变最终排序，但已经为混合检索打好基础：同一个问题既可以问“语义上像不像”，也可以问“关键字是否真的出现”。

## 相对 B07 的变更

| 组件 | 之前 (B07) | 之后 (B08) |
| --- | --- | --- |
| 检索信号 | 只有向量点积（语义相似） | 新增 BM25 关键词分（字面命中） |
| 新增模块 | 无 | `keyword.ts`：`tokenize()` / `buildKeywordIndex()` / `scoreBm25()` |
| 中文处理 | 依赖 embedding 模型 | bigram 分词，零依赖、可解释 |
| 排序影响 | 决定 TopK | 暂不参与排序，下一章才融合 |

## 试一试

本章是独立算法小节，直接跑 `main.ts` 里的小例子即可（无需向量库在线）：

```bash
npm run dev
```

然后观察：

1. 打印的分词结果里，中文被切成 `生日, 日券, 券怎…` 这样的 bigram 片段。
2. 含「退货」字面词的那条记录，BM25 分数明显高于另一条。
3. 把查询换成库里没有的词（如 `优惠券`），两条记录的分数都应该接近 0。
4. 给 `content` 里多重复几遍某个查询词，再跑一次，观察该词的贡献先升后趋缓（词频饱和）。

## 本章小结

- 关键词检索回答的是“查询词有没有明确出现在文本里”，和向量检索的“语义像不像”互补。
- `tokenize()`：英文/数字按连续字母数字切，中文按 **bigram** 切，零依赖。
- BM25 的直觉：词在当前 chunk 出现越多越重要（但增长递减），在全库越少见越能区分（IDF），chunk 太长要做长度校正。
- 本章只产出分数，**还没改排序**，下一章才把它接进检索器。

:::note[下一章：B09 混合检索与同源去重]
下一章把向量分数和 BM25 分数按权重融合排序，并用 `selectDiverseHits()` 限制单个文件占满 TopK，让上下文证据更多样。检索阶段到此收尾。
:::
