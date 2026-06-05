---
title: 接入向量数据库
description: 解释什么时候需要从本地 NDJSON 迁移到向量数据库，以及如何守住 storage / retrieval 边界。
---

tiny-rag 默认使用本地 `vector-store.ndjson` 和 `Float32Array` 线性扫描。这对学习、小知识库和本地调试足够透明。但当数据量、过滤条件或多知识库需求上来后，就可以考虑接入向量数据库。

> **扩展落点**：替换 storage / retrieval 的一部分，不改 query 编排和 Prompt。

:::note[本章目标]
读完这一章，你应该能判断什么时候需要向量数据库，以及如何接入而不让数据库 SDK 污染整条 RAG 链路。
:::

## 什么时候需要

先不要因为“RAG 就应该有向量数据库”而提前接入。下面这些现象出现后再考虑：

| 现象 | 向量数据库的价值 |
| --- | --- |
| chunk 数量很大，线性扫描变慢 | ANN 索引提高查询速度 |
| 需要按知识库、用户、标签过滤 | metadata filter 更自然 |
| 多进程 / 多服务共享索引 | 数据库比本地文件更好协调 |
| 需要增量 upsert / delete | 不必每次重写完整 NDJSON |
| 需要运维可观测性 | 数据库能提供索引状态和查询指标 |

如果只是几百到几千个 chunk，本地文件通常更容易理解和排查。

## 守住接口

tiny-rag 已经有适合替换的接口形状：

```ts
{
  meta: StoreMeta;
  recordCount: number;
  search(queryEmbedding, queryText, options): SearchResult;
}
```

外部数据库只要也返回 `SearchResult` / `SearchHit[]`，`query()` 后面的流程不用变：

```text
retriever.search()
  -> candidates
  -> selectDiverseHits()
  -> buildContext()
  -> chat()
```

不要把 Qdrant、Milvus、pgvector 等 SDK 直接塞进 `query.ts`。数据库细节应该留在新的 retriever 实现里。

## 数据模型

向量数据库里通常要存三类信息：

| 类型 | 字段 |
| --- | --- |
| 向量 | `embedding` |
| 文本 | `id`、`source`、`chunkIndex`、`heading`、`content` |
| 元数据 | `provider`、`model`、`dim`、知识库 id、权限标签、hash |

最容易漏的是 `_meta`。即使用了数据库，也仍然要知道这批向量来自哪个 embedding 模型。否则换模型后旧向量和新查询向量混用，排序会看似正常但没有意义。

## ingest 怎么变

本地 NDJSON 的导入是：

```text
loadDocuments -> chunk -> embed -> writeVectorStore
```

接入向量数据库后变成：

```text
loadDocuments -> chunk -> embed -> upsert vectors
```

写入目标变了，但前半段不应该变。`loadDocuments()`、`buildChunkRecords()`、`buildEmbeddingText()`、embedding 校验仍然复用。

如果数据库支持按 `id` upsert，可以让 `id = source#chunkIndex` 继续作为主键。需要删除旧 chunk 时，要额外处理“文档变短后旧 id 残留”的问题，常见做法是按 source 先删后写，或引入 ingest run id 做清理。

## 查询怎么变

本地检索是线性扫描所有向量：

```text
for each record:
  vectorScore = dot(query, record.embedding)
```

向量数据库检索是把这一步下推：

```text
db.search(queryEmbedding, topN, filters)
  -> candidates
```

需要注意：数据库返回的分数含义可能不同。有的返回 cosine similarity，有的返回 distance，数值越小越相似。接入时要统一成 tiny-rag 的习惯：`score` 越大越相关。

## ANN 与 HNSW 直觉

很多向量数据库默认使用近似最近邻（ANN）索引，比如 HNSW。它的目标不是保证每次都找到数学上绝对最近的向量，而是在速度和召回率之间取平衡。

可以这样理解：

```text
线性扫描：慢，但精确
ANN/HNSW：快，但可能漏掉少数近邻
```

参数通常会影响：

- 建索引成本
- 查询速度
- 召回率
- 内存占用

所以接入向量数据库后，RAG 评测更重要。你要确认 ANN 加速没有把关键 source 漏掉。

## 常见错误

| 错误 | 后果 |
| --- | --- |
| 把数据库 SDK 写进 `query.ts` | 以后换数据库要改全链路 |
| 只存向量不存文本 | 命中后无法构造 context |
| 不保存 provider/model/dim | 容易混用 embedding 空间 |
| 直接相信数据库分数方向 | distance / similarity 可能反了 |
| 过滤放在 Prompt | 无权 chunk 已经泄漏进上下文 |

## 本章小结

- 向量数据库主要解决规模、过滤、共享和增量更新，不是 RAG 的必需起点。
- 接入点应该在 storage / retrieval，不应该影响 Prompt 和 query 编排。
- 数据库里除了向量，还要保存文本、source、metadata 和 embedding 契约。
- ANN/HNSW 是速度和召回率的权衡，接入后必须用固定评测集验证。

:::note[继续阅读]
接入数据库前，先理解 [RAG 回归评测](/tiny-rag/evaluation/)；接入后，用 [诊断与解析方法](/tiny-rag/diagnostics/) 对比本地检索和数据库检索的 candidates 是否一致。
:::
