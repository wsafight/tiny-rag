---
title: "B09: 混合检索与同源去重"
description: 融合向量分数和 BM25 分数，并限制同一 source 占用过多上下文。
---

上一章已经能算关键词分。这一章把 BM25 接进 `createRetriever()`，让检索同时考虑语义相似和字面命中，并限制同一个文件占满 TopK。

## 先理解：混合检索是分数融合

混合检索的思路是把两种信号合并：

```text
最终分数 = 语义相似分 * 语义权重 + 关键词分 * 关键词权重
```

`KEYWORD_WEIGHT` 越高，字面匹配越重要；越低，语义相似越重要。小知识库里通常从 `0.3` 开始调，比一上来只靠向量检索更稳。

向量点积的理论范围是 `[-1, 1]`，实际相近文本通常落在正区间。BM25 分数范围不定，所以先把 BM25 归一到当前候选里的最大值，再按权重融合。

## 升级检索器

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

## 同源去重

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

## 验证

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
