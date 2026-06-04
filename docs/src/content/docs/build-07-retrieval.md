---
title: "B07: 纯向量检索与 TopK"
description: 从问题 embedding 到点积排序，深度理解纯向量检索能做什么、不能保证什么。
---

向量库就绪后，检索就是：把问题也变成向量，和每条 chunk 比相似度，取最高的 TopK。这一章先做最纯粹的向量检索，后面两章再加入关键词和混合排序。

纯向量检索是 RAG 最核心也最容易被误解的一步。它不是在“找答案”，而是在“找语义上接近的问题和片段”。这个区别很重要，因为命中片段是否真的包含答案，还需要后续 Prompt 和模型生成来处理。

:::note[本章产出]
- **前置**：读完 `B06`，有一个可读取、可校验的向量库。
- **产出**：在 `vector.ts` 加 `dot()`，新建 `retrieval.ts`（`createRetriever()`）和 `search.ts`（`searchOnce()`），跑通“问题 → 向量 → TopK 命中表”。
- **核心收获**：理解 TopK 是“当前排序下前 K 个”，**不等于答案**；以及为什么把“加载”和“检索”分开。
:::

## 先理解：查询也是一次 embedding

向量库里已经有每个 chunk 的 embedding，但用户问题还只是一段普通文本。检索前必须先把问题也交给同一个 embedding 模型，得到问题向量，再和库里的 chunk 向量比较。

这里有两个容易混淆的点：

- TopK 只是“最相关的几个片段”，不是最终答案。
- 相似度分数只说明向量距离近，不保证片段一定包含答案。

所以查询阶段后面还要继续做两件事：先把向量检索和关键词信号融合，让召回更稳；再把命中片段交给聊天模型，让模型基于参考内容组织回答。

TopK 的语义也要看清：它只是“当前排序下前 K 个”。如果知识库没有答案，TopK 仍然会返回最像的几个片段。真实 tiny-rag 会再用 `MIN_SCORE` 过滤弱相关结果，避免模型拿着无关上下文硬答。

:::caution[TopK 一定返回结果，哪怕库里没答案]
向量检索永远会给你“最像的 K 个片段”，即使知识库里根本没有相关内容——它返回的是“最不差的”，不是“正确的”。这就是新手常踩的坑：以为有命中就有答案。后面会用两道防线兜底：`MIN_SCORE` 过滤掉分数太低的弱相关片段，`B10` 的 Prompt 让模型在证据不足时明确说“不知道”。
:::

## 余弦相似度

导入时每条 chunk 已经 L2 归一化。查询时把问题向量也归一化，那么两者的点积就是余弦相似度，范围 `[-1, 1]`，越大越相似。

复用 `vector.ts`，加一个点积函数：

```ts
// vector.ts（续）
export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('向量维度不一致');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
```

这里继续保持“导入归一化，查询也归一化”的约定。只要向量库里的记录已经归一化，检索时就可以用点积快速比较。后面 tiny-rag 把向量放进 `Float32Array`，也是为了让这个点积循环更快。

## 检索器

`createRetriever()` 接收已加载的向量库，返回一个 `search()` 闭包。把「加载」和「检索」分开，是为了让后面的 HTTP 服务能加载一次、反复查询。

```ts
// retrieval.ts
import { dot, normalize } from './vector';
import type { LoadedStore } from './store';
import type { SearchHit } from './types';

export interface Retriever {
  search(questionEmbedding: readonly number[], topK: number): SearchHit[];
}

export function createRetriever(store: LoadedStore): Retriever {
  return {
    search(questionEmbedding, topK) {
      const query = normalize([...questionEmbedding]);
      const scored: SearchHit[] = store.records.map((r) => ({
        id: r.id,
        source: r.source,
        chunkIndex: r.chunkIndex,
        heading: r.heading,
        content: r.content,
        score: dot(query, r.embedding),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },
  };
}
```

`createRetriever()` 返回闭包，是查询性能的关键铺垫。CLI 每次执行都可以重新创建它；HTTP 服务则可以在启动时创建一次，后续所有请求复用同一个内存索引。接口一样，生命周期不同。

## 检索一次

把「加载向量库 → 问题向量化 → 检索」串起来。新建 `search.ts`：

```ts
// search.ts
import { loadVectorStore, validateMeta } from './store';
import { createRetriever } from './retrieval';
import type { EmbedFunction } from './providers';
import type { SearchHit } from './types';

export async function searchOnce(
  storePath: string,
  question: string,
  embed: EmbedFunction,
  provider: string,
  model: string,
  topK = 4,
): Promise<SearchHit[]> {
  const store = await loadVectorStore(storePath);
  const [questionVec] = await embed([question]);
  validateMeta(store.meta, provider, model, questionVec.length);
  return createRetriever(store).search(questionVec, topK);
}
```

注意 `validateMeta` 放在拿到问题向量之后——此时才知道问题向量的维度，可以和向量库 `dim` 比对，确保用的是同一个 embedding 模型。

## 验证

```ts
// main.ts
import { searchOnce } from './search';
import { createEmbedder } from './providers';

const model = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const embed = createEmbedder({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1', model });

const hits = await searchOnce('./vector-store.ndjson', '怎么取消订单？', embed, 'lmstudio', model);
console.log('#  score   source         heading');
hits.forEach((h, i) => {
  console.log(`${i + 1}  ${h.score.toFixed(4)}  ${h.source.padEnd(14)} ${h.heading}`);
});
```

运行后预期类似（取消订单那段排在最前）：

```text
#  score   source         heading
1  0.8123  faq.md         订单问题 > 取消订单
2  0.4210  sub/policy.md  售后规则
```

纯向量检索能抓住语义相近的内容，但对专有名词、产品编号、中文短词这类「字面匹配」并不敏感。后面两章会先加入关键词 / BM25，再做混合检索。

如果这一章的检索结果不理想，先不要急着改 Prompt。Prompt 只能约束模型如何使用命中片段，不能让模型看到没有召回的证据。先检查 chunk 是否合理、embedding 模型是否正确、TopK 是否过小，再进入生成阶段。

## 本章小结

- 检索 = 把问题也 embedding，和库里每条 chunk 算点积（已归一化，点积即余弦相似度），排序取 TopK。
- `createRetriever()` 返回一个 `search()` 闭包：CLI 每次重建，HTTP 服务启动时建一次后复用——接口相同，生命周期不同。
- `validateMeta()` 放在拿到问题向量之后，才能用问题向量的维度去比对库里的 `dim`。
- 纯向量检索擅长语义相近，但对专有名词、编号、中文短词等**字面匹配**不敏感。

:::note[下一章：B08 关键词分词与 BM25]
为了补上字面匹配，下一章实现中文友好的分词和 BM25 打分，给语义检索加一条“词项证据”的硬信号。本章先单独把关键词分数做出来，`B09` 再融合。
:::
