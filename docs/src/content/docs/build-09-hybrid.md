---
title: "B09: 混合检索与同源去重"
description: 把语义分数和 BM25 分数融合排序，并通过同源限制提升上下文证据多样性。
---

上一章已经能算关键词分。这一章把 BM25 接进 `createRetriever()`，让检索同时考虑语义相似和字面命中，并限制同一个文件占满 TopK。

混合检索是从“能召回”走向“召回更稳”的关键步骤。纯向量检索容易忽略精确词，纯关键词检索又不懂同义表达。把两者融合后，同一个查询既能命中语义相关片段，也能让关键字强相关的片段获得额外优势。

`B01 > B02 > B03 > B04 > B05 > B06 | B07 > B08 > [ B09 ] B10`

> *"融合排序 + 同源去重，别让一个文件垄断上下文。"* —— 检索的稳，靠的是尺度对齐与证据多样性。
>
> **查询阶段**：这一章在主链路上加的是混合排序与同源限制这一块能力。

:::note[本章产出]
- **前置**：读完 `B07`（向量检索）和 `B08`（BM25）。
- **产出**：升级 `retrieval.ts`，让 `createRetriever()` 融合两种分数，并加 `selectDiverseHits()` 做同源限制。
- **核心收获**：理解分数融合的关键不是公式，而是**尺度对齐**；以及 `KEYWORD_WEIGHT`、`PER_SOURCE_LIMIT` 各调什么。
:::

## 问题

用户搜“7 天退货”，纯向量检索可能把语义泛泛相关的“配送时效”排到前面，而真正含「退货」字面词的售后条款反而靠后——精确词被语义噪声淹没了。反过来，纯关键词检索又读不懂“怎么退款”和“原路返还”是一回事。

混合检索的思路是把两种信号合并：

```text
最终分数 = 语义相似分 * 语义权重 + 关键词分 * 关键词权重
```

`KEYWORD_WEIGHT` 越高，字面匹配越重要；越低，语义相似越重要。小知识库里通常从 `0.3` 开始调，比一上来只靠向量检索更稳。

## 解决方案

向量点积的理论范围是 `[-1, 1]`，实际相近文本通常落在正区间。BM25 分数范围不定，所以先把 BM25 归一到当前候选里的最大值，再按权重融合。

```text
候选片段 ──► 算向量分（点积） ──┐
        └─► 算 BM25 分 ─► 归一化 ─┴─► 加权求和 ─► 排序 ─► 同源限制 ─► TopK
```

分数融合最重要的不是公式多复杂，而是尺度要可控。向量分数和 BM25 分数不是同一种量纲，直接相加会让某一方支配排序。先归一化关键词分，再用 `KEYWORD_WEIGHT` 调整影响力，是一个容易理解也容易调试的起点。核心洞察是——**异构分数融合的前提是先对齐尺度，再谈权重**。

:::caution[两种分数不能直接相加]
向量点积大致落在 `[-1, 1]`，BM25 分数却没有固定上界（可能是 0，也可能是十几）。如果直接 `向量分 + BM25 分`，BM25 会轻易盖过向量分，混合检索就名存实亡。所以代码先把 BM25 归一化到“当前候选里的最大值”（缩放到 `[0, 1]`），再用 `KEYWORD_WEIGHT` 加权。**先对齐尺度，再谈权重**，这是融合任何异构分数的通用前提。
:::

## 工作原理

### 1. 升级检索器

把 BM25 接进 `createRetriever()`。检索时先算每条的向量分和 BM25 分，归一化后融合排序：

```ts
// retrieval.ts
import { dot, normalize } from './vector';
import { tokenize, buildKeywordIndex, scoreBm25, type KeywordIndex } from './keyword';
import type { LoadedStore } from './store';
import type { SearchHit } from './types';

export interface Retriever {
  search(questionEmbedding: readonly number[], questionText: string, opts: SearchOptions): SearchHit[];
}
export interface SearchOptions {
  topK: number;
  keywordWeight?: number;
  perSourceLimit?: number;
}

export function createRetriever(store: LoadedStore): Retriever {
  const index: KeywordIndex = buildKeywordIndex(store.records);
  return {
    search(questionEmbedding, questionText, opts) {
      const query = normalize([...questionEmbedding]);
      const queryTerms = tokenize(questionText);
      const kw = opts.keywordWeight ?? 0.3;

      const raw = store.records.map((r, i) => ({
        record: r,
        vectorScore: dot(query, r.embedding),
        keywordRaw: scoreBm25(index, i, queryTerms),
      }));
      const maxKw = Math.max(0, ...raw.map((x) => x.keywordRaw));

      const scored: SearchHit[] = raw.map((x) => {
        const keywordScore = maxKw > 0 ? x.keywordRaw / maxKw : 0;
        return {
          id: x.record.id,
          source: x.record.source,
          chunkIndex: x.record.chunkIndex,
          heading: x.record.heading,
          content: x.record.content,
          score: (1 - kw) * x.vectorScore + kw * keywordScore,
        };
      });
      scored.sort((a, b) => b.score - a.score);
      return selectDiverseHits(scored, opts.topK, opts.perSourceLimit ?? 2);
    },
  };
}
```

这段检索器仍然保持一个重要边界：它只返回 `SearchHit[]`，不负责生成答案。也就是说，无论内部是向量检索、BM25、混合检索还是未来接向量数据库，query 编排都只需要拿到同一种命中结构。

### 2. 同源去重

一个长文档可能在排序里占满多个名次，但回答往往需要来自不同文件的证据。`selectDiverseHits()` 限制每个 `source` 最多进入 N 条：

```ts
// retrieval.ts（续）
function selectDiverseHits(sorted: readonly SearchHit[], topK: number, perSource: number): SearchHit[] {
  const counts = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const hit of sorted) {
    const n = counts.get(hit.source) ?? 0;
    if (n >= perSource) continue;
    counts.set(hit.source, n + 1);
    out.push(hit);
    if (out.length >= topK) break;
  }
  return out;
}
```

这里更准确地说是“同源限制”，不是严格去重。同一个文件里的多个 chunk 可能都相关，但如果它们把 TopK 全占满，模型就看不到其他来源的补充证据。`PER_SOURCE_LIMIT` 是在相关性和多样性之间做一个简单平衡。

### 3. 验证

`searchOnce()` 加上 `questionText` 参数（向量库加载、问题向量化部分同“B07”）：

```ts
// main.ts
import { loadVectorStore, validateMeta } from './store';
import { createRetriever } from './retrieval';
import { createEmbedder } from './providers';

const model = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const embed = createEmbedder({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1', model });

const question = '7 天能退货吗？';
const store = await loadVectorStore('./vector-store.ndjson');
const [vec] = await embed([question]);
validateMeta(store.meta, 'lmstudio', model, vec.length);

const hits = createRetriever(store).search(vec, question, { topK: 4, keywordWeight: 0.3 });
hits.forEach((h, i) => console.log(`${i + 1}  ${h.score.toFixed(4)}  ${h.source}  ${h.heading}`));
```

含「退货」字面词的查询，混合检索会让 `售后规则` 那段排名更稳。检索环节完成——下一章把命中片段拼成上下文，交给模型回答。

调混合检索时建议按现象来：专有名词和短词总是被漏掉，就提高 `KEYWORD_WEIGHT`；普通自然语言问题被字面噪声干扰，就降低它；同一长文档占满上下文，就降低 `PER_SOURCE_LIMIT`。先看命中表，再调参数。

## 相对 B08 的变更

| 组件 | 之前 (B08) | 之后 (B09) |
| --- | --- | --- |
| 检索信号 | 仅 BM25 关键词分（独立函数） | 向量分 + BM25 分融合排序 |
| 分数尺度 | 不涉及融合 | BM25 归一化到候选最大值后加权 |
| `createRetriever()` | 仅向量检索 | 接入 `keyword.ts`，按 `KEYWORD_WEIGHT` 融合 |
| 结果多样性 | 无约束 | `selectDiverseHits()` 限制每个 `source` 至多 N 条 |
| 可调参数 | 无 | `keywordWeight`、`perSourceLimit` |

## 试一试

把本章的混合检索接进检索器后跑一次（确保 `B02` 的 embedding 服务在线）：

```bash
npm run dev
```

然后观察：

1. 用含「退货」字面词的问题（如 `7 天能退货吗？`）检索，确认 `售后规则` 那段排名比纯向量检索更稳。
2. 把 `keywordWeight` 调到 `0` 和 `0.8` 各跑一次，对比命中表的排序变化。
3. 找一篇长文档反复命中，把 `perSourceLimit` 从 `2` 调到 `1`，确认 TopK 里出现了更多来源。

## 本章小结

- 混合检索 = `(1 - kw) * 向量分 + kw * 归一化后的 BM25 分`，`kw` 即 `KEYWORD_WEIGHT`（默认 0.3）。
- 融合前必须把 BM25 归一化到候选最大值，否则量纲不一致，一方会支配排序。
- `selectDiverseHits()` 是“同源限制”而非严格去重：每个 `source` 最多进 N 条，避免单文件垄断上下文。
- 检索器始终只返回 `SearchHit[]`，不碰生成——这层边界让未来换向量数据库也不影响 query 编排。

:::note[下一章：B10 Prompt 与端到端问答]
检索阶段完成。最后一章把命中片段拼成带编号的上下文，写好划定安全边界的 system prompt，再用 `query()` 把检索和生成串成完整链路，`mini-rag` 正式跑通。
:::
