---
title: "B07: 纯向量检索与 TopK"
description: 从问题 embedding 到点积排序，深度理解纯向量检索能做什么、不能保证什么。
---

向量库就绪后，检索就是：把问题也变成向量，和每条 chunk 比相似度，取最高的 TopK。这一章先做最纯粹的向量检索，后面两章再加入关键词和混合排序。

纯向量检索是 RAG 最核心也最容易被误解的一步。它不是在“找答案”，而是在“找语义上接近的问题和片段”。这个区别很重要，因为命中片段是否真的包含答案，还需要后续 Prompt 和模型生成来处理。

`B01 > B02 > B03 > B04 > B05 > B06 | [ B07 ] B08 > B09 > B10`

> *"检索不是找答案，是找最像的 K 个片段。"* —— 把问题映射到同一个向量空间，取最像的 K 个。
>
> **查询阶段**：这一章在主链路上加的是“问题向量化 → 点积排序 → TopK 命中表”这一块能力。

:::note[本章产出]
- **前置**：读完 `B06`，有一个可读取、可校验的向量库。
- **产出**：在 `vector.ts` 加 `dot()`，新建 `retrieval.ts`（`createRetriever()`）和 `search.ts`（`searchOnce()`），跑通“问题 → 向量 → TopK 命中表”。
- **核心收获**：理解 TopK 是“当前排序下前 K 个”，**不等于答案**；以及为什么把“加载”和“检索”分开。
:::

## 问题

向量库里已经躺着每个 chunk 的 embedding，可用户问题还只是一段普通文本——“怎么取消订单？”此刻还是字符串，跟库里那一排排数字根本没法直接比较。检索前必须先把问题也交给同一个 embedding 模型，得到问题向量，再和库里的 chunk 向量逐条比较。

这里有两个容易混淆的点：

- TopK 只是“最相关的几个片段”，不是最终答案。
- 相似度分数只说明向量距离近，不保证片段一定包含答案。

所以查询阶段后面还要继续做两件事：先把向量检索和关键词信号融合，让召回更稳；再把命中片段交给聊天模型，让模型基于参考内容组织回答。

TopK 的语义也要看清：它只是“当前排序下前 K 个”。如果知识库没有答案，TopK 仍然会返回最像的几个片段。真实 tiny-rag 会再用 `MIN_SCORE` 过滤弱相关结果，避免模型拿着无关上下文硬答。

:::caution[TopK 一定返回结果，哪怕库里没答案]
向量检索永远会给你“最像的 K 个片段”，即使知识库里根本没有相关内容——它返回的是“最不差的”，不是“正确的”。这就是新手常踩的坑：以为有命中就有答案。后面会用两道防线兜底：`MIN_SCORE` 过滤掉分数太低的弱相关片段，`B10` 的 Prompt 让模型在证据不足时明确说“不知道”。
:::

## 解决方案

把检索拆成一条固定流水：

```text
问题文本
  → embedding（同一个模型）→ 问题向量
  → L2 归一化
  → 和库里每条 chunk 向量做点积（已归一化 = 余弦相似度）
  → 按分数降序排序
  → 取前 TopK 条 → 命中表
```

导入时每条 chunk 已经 L2 归一化。查询时把问题向量也归一化，那么两者的点积就是余弦相似度，范围 `[-1, 1]`，越大越相似。把“加载向量库”和“执行检索”拆成两步，是为了让后面的 HTTP 服务能加载一次、反复查询。

核心洞察是——**检索的本质是“在同一个向量空间里给所有 chunk 排个序，取最靠前的 K 个”，它永远有结果，但结果只是“最像的”，不保证“正确的”**。

## 工作原理

### 1. 点积与归一化

复用 `vector.ts`，加一个点积函数：

```ts
// vector.ts（续）
export function dot(a: readonly number[], b: readonly number[]): number {
  // 点积要求两个向量维度一致；不一致通常说明向量库和查询模型不匹配。
  if (a.length !== b.length) throw new Error('向量维度不一致');
  let s = 0;
  // 两个向量都已 L2 归一化时，点积就是余弦相似度。
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
```

这里继续保持“导入归一化，查询也归一化”的约定。只要向量库里的记录已经归一化，检索时就可以用点积快速比较。后面 tiny-rag 把向量放进 `Float32Array`，也是为了让这个点积循环更快。

:::tip[原理补充：为什么点积可以当相似度]
余弦相似度本来是 `dot(a, b) / (|a| * |b|)`，比较的是两个向量方向是否接近。导入和查询都做 L2 归一化后，`|a|` 和 `|b|` 都等于 1，公式就只剩 `dot(a, b)`。所以这里的点积不是在比较“文本长度”，而是在比较两个文本在同一向量空间里的方向接近程度。
:::

### 2. 检索器

`createRetriever()` 接收已加载的向量库，返回一个 `search()` 闭包。把「加载」和「检索」分开，是为了让后面的 HTTP 服务能加载一次、反复查询。

```ts
// retrieval.ts
import { dot, normalize } from './vector';
import type { LoadedStore } from './store';
import type { SearchHit } from './types';

export interface Retriever {
  /** 输入问题向量和 topK，返回按相似度排序后的命中片段。 */
  search(questionEmbedding: readonly number[], topK: number): SearchHit[];
}

export function createRetriever(store: LoadedStore): Retriever {
  // store 被闭包捕获；HTTP 服务可以启动时创建一次 retriever 后反复复用。
  return {
    search(questionEmbedding, topK) {
      // 查询向量也要归一化，和导入阶段写入的归一化 chunk 向量保持同一尺度。
      const query = normalize([...questionEmbedding]);
      const scored: SearchHit[] = store.records.map((r) => ({
        // SearchHit 只保留检索和 prompt 需要的字段，不暴露完整存储实现。
        id: r.id,
        source: r.source,
        chunkIndex: r.chunkIndex,
        heading: r.heading,
        content: r.content,
        // 分数越大，代表当前问题和该 chunk 的向量方向越接近。
        score: dot(query, r.embedding),
      }));
      // 先全量排序，再取 TopK；学习版用线性扫描保持实现透明。
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },
  };
}
```

`createRetriever()` 返回闭包，是查询性能的关键铺垫。CLI 每次执行都可以重新创建它；HTTP 服务则可以在启动时创建一次，后续所有请求复用同一个内存索引。接口一样，生命周期不同。

### 3. 检索一次

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
  // 每次 searchOnce 都重新加载向量库；后续服务化时会改成启动时加载一次。
  const store = await loadVectorStore(storePath);
  // 问题必须使用和向量库相同的 embedding 模型转成向量。
  const [questionVec] = await embed([question]);
  // 拿到问题向量后才知道 dim，才能完整校验 meta。
  validateMeta(store.meta, provider, model, questionVec.length);
  return createRetriever(store).search(questionVec, topK);
}
```

注意 `validateMeta` 放在拿到问题向量之后——此时才知道问题向量的维度，可以和向量库 `dim` 比对，确保用的是同一个 embedding 模型。

### 4. 验证

```ts
// main.ts
import { searchOnce } from './search';
import { createEmbedder } from './providers';

const model = process.env.EMBED_MODEL ?? 'nomic-embed-text';
// 查询问题的 embedder 必须和 ingest 时使用的是同一个模型。
const embed = createEmbedder({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1', model });

const hits = await searchOnce('./vector-store.ndjson', '怎么取消订单？', embed, 'lmstudio', model);
console.log('#  score   source         heading');
hits.forEach((h, i) => {
  // 命中表是排查 RAG 的第一现场：先看 source/heading，再看最终回答。
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

## 相对 B06 的变更

| 组件 | 之前 (B06) | 之后 (B07) |
| --- | --- | --- |
| 向量库角色 | 可读取、可校验的静态资产 | 检索的数据源，被 `createRetriever()` 装载 |
| 相似度计算 | 无 | `vector.ts` 加 `dot()`：点积即余弦相似度 |
| 检索能力 | 无 | `retrieval.ts`（`createRetriever()`）返回 `search()` 闭包 |
| 端到端入口 | `ingest()` 写库 | `search.ts`（`searchOnce()`）：问题 → 向量 → TopK |
| 结果形态 | 内存里的记录 | 排序后的 `SearchHit[]` 命中表 |

## 试一试

确保向量库已生成（`B06` 的 `ingest()` 跑过），再用一个问题查一次：

```bash
npm run dev
```

然后观察：

1. 命中表按 `score` 从高到低排序，最相关的片段排在第一行。
2. 换一个知识库里根本没有答案的问题，TopK 仍然返回结果——这就是 `MIN_SCORE` 要兜底的原因。
3. 把 `topK` 从 4 改成 1，再改成 8，观察命中表行数随之变化。
4. 故意用一个和向量库不同的 `EMBED_MODEL`，确认 `validateMeta()` 直接报错而不是默默算出错误排序。

## 本章小结

- 检索 = 把问题也 embedding，和库里每条 chunk 算点积（已归一化，点积即余弦相似度），排序取 TopK。
- `createRetriever()` 返回一个 `search()` 闭包：CLI 每次重建，HTTP 服务启动时建一次后复用——接口相同，生命周期不同。
- `validateMeta()` 放在拿到问题向量之后，才能用问题向量的维度去比对库里的 `dim`。
- 纯向量检索擅长语义相近，但对专有名词、编号、中文短词等**字面匹配**不敏感。

:::note[下一章：B08 关键词分词与 BM25]
为了补上字面匹配，下一章实现中文友好的分词和 BM25 打分，给语义检索加一条“词项证据”的硬信号。本章先单独把关键词分数做出来，`B09` 再融合。
:::
