---
title: "B07: 纯向量检索与 TopK"
description: 把问题向量化，用点积算余弦相似度，做纯向量 TopK 检索。
---

向量库就绪后，检索就是：把问题也变成向量，和每条 chunk 比相似度，取最高的 TopK。这一章先做最纯粹的向量检索，后面两章再加入关键词和混合排序。

## 先理解：查询也是一次 embedding

向量库里已经有每个 chunk 的 embedding，但用户问题还只是一段普通文本。检索前必须先把问题也交给同一个 embedding 模型，得到问题向量，再和库里的 chunk 向量比较。

这里有两个容易混淆的点：

- TopK 只是“最相关的几个片段”，不是最终答案。
- 相似度分数只说明向量距离近，不保证片段一定包含答案。

所以查询阶段后面还要继续做两件事：先把向量检索和关键词信号融合，让召回更稳；再把命中片段交给聊天模型，让模型基于参考内容组织回答。

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
