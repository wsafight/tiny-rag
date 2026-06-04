---
title: 当前做的优化
description: tiny-rag 在简化版主链路之上做的工程优化——增量缓存、跳过重建、内存索引复用、原子写入等。
---

`mini-rag` 跑通了主链路，但每一步都是最朴素的实现。tiny-rag 在同一条链路上做了一系列工程优化。这一章逐项对照：每个优化解决什么问题、`mini-rag` 的朴素做法是什么、tiny-rag 怎么改。

## 标题加权 embedding

- **朴素做法**：embedding 文本就是 `heading\ncontent`，标题只出现一次。
- **tiny-rag**：`buildEmbeddingText()` 把标题重复 `HEADING_WEIGHT` 次（默认 2）再拼正文，相当于告诉 embedding 模型「标题是理解这段的重要上下文」。

标题准确时能提升召回；标题很泛（每段都叫「说明」）时帮助有限。

## hash 增量缓存

- **朴素做法**：`ingest()` 每次对所有 chunk 重新调 embedding。改一个错别字也要全量重算。
- **tiny-rag**：每个 chunk 用 `embeddingText` 算 SHA1 存进 `hash` 字段。重新导入时，`readEmbeddingCache()` 从旧向量库按 hash 取回未变化 chunk 的向量，只对 miss 的 chunk 调 embedding。

```ts
const cache = await readEmbeddingCache(config, vectorStore, intermediateDir);
const records = chunks.map((c) => {
  const cached = cache.get(c.hash);
  return { ...c, embedding: hasValidEmbedding(cached) ? cached : null };
});
```

这不是永久缓存，而是一次导入内的成本优化，最终仍写出完整向量库。

## 导入指纹跳过重建

- **朴素做法**：即使文档一个字没变，`ingest()` 也会重新算、重新写文件。
- **tiny-rag**：`buildIngestFingerprint()` 把 schema 版本、provider、model、切块参数、以及每个 chunk 的 id/source/hash/关键词统计全算成一个指纹，存进 `_meta.ingestFingerprint`。下次导入若指纹一致，直接返回 `skippedReason: 'unchanged'`，不调 embedding 也不重写文件。

配合三个提前返回 `no-docs` / `no-chunks` / `unchanged`，让「什么都没变」的导入几乎零成本。

## 关键词统计预计算

- **朴素做法**：B09 里 `createRetriever()` 会在查询链路中构建关键词索引，简化实现没有把关键词统计提前写入向量库。
- **tiny-rag**：导入阶段 `buildKeywordStats()` 就把每个 chunk 的标题词频、正文词频、token 数算好存进向量库。查询时直接读统计做 BM25，不必每次重新分词全部文档。

## Float32Array 内存矩阵

- **朴素做法**：`loadVectorStore()` 把每条 embedding 读成 `number[]`，查询时遍历 `number[][]` 做点积。
- **tiny-rag**：加载时把所有向量摊平进一个连续的 `Float32Array`，记录只保留 `embeddingOffset`。点积时按 offset 直接在这块内存上算。

```ts
dotEmbeddingAt(queryEmbedding, store.embeddings, record.embeddingOffset)
```

比 `number[][]` 更紧凑、对重复查询的 CPU 缓存更友好。

## 中间缓存

- **朴素做法**：每次启动都要重新 parse 整个 NDJSON。
- **tiny-rag**：配置 `INTERMEDIATE_DIR` 后，`loadVectorStore()` 把加载结果缓存成 `*.manifest.json` / `*.records.ndjson` / `*.embeddings.f32` 三类文件。manifest 记录原文件路径、大小、mtime、记录数、维度；下次加载若这些一致，直接读二进制 `Float32Array`，跳过 NDJSON parse。

只影响加载速度，不改变向量库格式。

## 内存索引复用

- **朴素做法**：B10 的 `query()` 每次都 `loadVectorStore()` + `createRetriever()`。
- **tiny-rag**：HTTP 服务启动时加载一次 retriever，每个 `/query` 复用同一个内存索引；只有 `POST /reload` 才重新加载。CLI 因为是短生命周期进程，仍每次重建——这对调试更直观。

## 原子写入

- **朴素做法**：`writeFile()` 直接写目标路径。写到一半进程退出，或查询服务刚好在读，就会读到半个文件。
- **tiny-rag**：先写临时文件，再 `rename` 到目标路径。rename 在同一文件系统上是原子操作，避免半写入文件被读到。

## 并发与重试

- **朴素做法**：`embed()` 串行发请求，失败直接抛。
- **tiny-rag**：导入按 `EMBED_BATCH_SIZE` 分批，用 `runWithConcurrency()` 按 `INGEST_CONCURRENCY` 控制批间并发；Ollama 单条 embedding 则用 `OLLAMA_EMBED_CONCURRENCY`。HTTP 层有超时（`REQUEST_TIMEOUT_MS`）和重试（`REQUEST_RETRIES`）——4xx 不重试（多半是配置错误），网络错误 / 超时 / 5xx 才重试。

## 鉴权与限流

- **朴素做法**：`mini-rag` 本身没有 HTTP 服务，更没有保护。
- **tiny-rag**：`SERVE_AUTH_TOKEN` 提供 Bearer 鉴权，`SERVE_MAX_CONCURRENCY` 限制在途查询数（超过返回 503），请求体限制 1MB。详见[入口章](./interfaces/)。

## embedding 校验

- **朴素做法**：直接信任 provider 返回的向量。
- **tiny-rag**：`validateEmbeddings()` 检查返回是数组、数量等于输入数、每个都是合法数字数组、维度一致。向量库一旦写入坏向量，查询会表现为「有分数但排序很怪」，排查成本更高——所以在写入前 fail-fast。

## 小结

| 优化 | 解决的问题 |
| --- | --- |
| hash 增量缓存 | 局部改文档不必全量重算 embedding |
| 导入指纹跳过 | 内容没变时零成本 |
| 关键词预计算 | 查询不必重复分词全部文档 |
| Float32Array 矩阵 | 重复查询更快、更省内存 |
| 中间缓存 | 服务启动跳过 NDJSON parse |
| 内存索引复用 | HTTP 查询不重复加载向量库 |
| 原子写入 | 避免读到半写入文件 |
| 并发 / 重试 | 导入更快、对瞬时故障更稳 |
| 鉴权 / 限流 | 保护模型服务和进程 |
| embedding 校验 | 坏向量在写入前就被拦下 |

这些优化都不改变主链路的语义，只改变它的成本和健壮性。这正是从「能跑的简化版」到「能用的小项目」之间的工程差距。
