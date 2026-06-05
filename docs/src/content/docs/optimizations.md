---
title: 工程优化如何工作
description: 对照 mini-rag 朴素实现，深度解读 tiny-rag 的增量缓存、内存索引、原子写入和运行保护。
---

`mini-rag` 跑通了主链路，但每一步都是最朴素的实现。tiny-rag 在同一条链路上做了一系列工程优化。这一章逐项对照：每个优化解决什么问题、`mini-rag` 的朴素做法是什么、tiny-rag 怎么改。

> **工程化阶段**：不改语义，只降成本、减少重复、让失败更早暴露。

这些优化的共同点是：不改变 RAG 的语义，只降低成本、减少重复工作、让失败更早暴露。理解这一点很重要。优化不是把系统变复杂的理由，而是当朴素实现已经暴露出明确问题时，给对应环节加保护。

:::note[本章目标]
本章是“mini-rag 朴素做法 vs tiny-rag 工程做法”的逐项对照。读的时候不必记住每个优化的实现细节，重点理解**每个优化在解决朴素实现暴露出的哪个具体问题**。新手可以先抓三类：导入省钱、查询提速、运行可靠。
:::

可以按三类来读本章：

| 类型 | 关注点 | 代表优化 |
| --- | --- | --- |
| 导入成本 | 少算 embedding，少重写文件 | hash 缓存、导入指纹 |
| 查询性能 | 少 parse、少分配、复用索引 | Float32Array、中间缓存、内存索引 |
| 运行可靠性 | 防坏数据、防半写入、防滥用 | 原子写入、校验、重试、鉴权 |

还有第四个容易被忽略的维度：**可解析性**。tiny-rag 保留 `meta`、`vectorScore`、`keywordScore`、`candidates`、`hits`、`skippedReason` 和耗时字段，不只是为了展示更多信息，而是为了让一次失败查询能被拆开分析。

如果一个系统只返回最终 `answer`，你很难知道问题发生在导入、召回还是生成；如果中间状态都能读出来，排查就会从“猜模型”变成“找证据断裂点”。这也是 [诊断与解析方法](/tiny-rag/diagnostics/) 单独成章的原因。

## 标题加权 embedding

- **朴素做法**：embedding 文本就是 `heading\ncontent`，标题只出现一次。
- **tiny-rag**：`buildEmbeddingText()` 把标题重复 `HEADING_WEIGHT` 次（默认 2）再拼正文，相当于告诉 embedding 模型「标题是理解这段的重要上下文」。

标题准确时能提升召回；标题很泛（每段都叫「说明」）时帮助有限。

这类优化依赖内容质量。它不会凭空创造语义，只是把已有的标题信息放大。标题越像“答案所在主题”，收益越明显。

## hash 增量缓存

- **朴素做法**：`ingest()` 每次对所有 chunk 重新调 embedding。改一个错别字也要全量重算。
- **tiny-rag**：每个 chunk 用 `embeddingText` 算 SHA1 存进 `hash` 字段。重新导入时，`readEmbeddingCache()` 从旧向量库按 hash 取回未变化 chunk 的向量，只对 miss 的 chunk 调 embedding。

```ts
// 先从旧向量库或 intermediate cache 里读出可复用的 hash -> embedding 映射。
const cache = await readEmbeddingCache(config, vectorStore, intermediateDir);
const records = chunks.map((c) => {
  // hash 来自 embeddingText；只要 chunk 文本和标题加权不变，就可以复用旧向量。
  const cached = cache.get(c.hash);
  // 命中缓存就直接带着 embedding 进入后续流程；miss 的 chunk 之后再批量调用模型。
  return { ...c, embedding: hasValidEmbedding(cached) ? cached : null };
});
```

这不是永久缓存，而是一次导入内的成本优化，最终仍写出完整向量库。

hash 缓存的粒度是 chunk，而不是整份文件。改一处内容时，未变化 chunk 的 embedding 可以复用；如果切块参数变化导致 chunk 边界全变，缓存自然会大量失效。

## 导入指纹跳过重建

- **朴素做法**：即使文档一个字没变，`ingest()` 也会重新算、重新写文件。
- **tiny-rag**：`buildIngestFingerprint()` 把 schema 版本、provider、model、切块参数、以及每个 chunk 的 id/source/hash/关键词统计全算成一个指纹，存进 `_meta.ingestFingerprint`。下次导入若指纹一致，直接返回 `skippedReason: 'unchanged'`，不调 embedding 也不重写文件。

配合三个提前返回 `no-docs` / `no-chunks` / `unchanged`，让「什么都没变」的导入几乎零成本。

导入指纹解决的是“是否需要构建”的问题，hash 缓存解决的是“构建时哪些向量能复用”的问题。两者叠加后，常见的重复导入成本会明显下降。

## 关键词统计预计算

- **朴素做法**：B09 里 `createRetriever()` 会在查询链路中构建关键词索引，简化实现没有把关键词统计提前写入向量库。
- **tiny-rag**：导入阶段 `buildKeywordStats()` 就把每个 chunk 的标题词频、正文词频、token 数算好存进向量库。查询时直接读统计做 BM25，不必每次重新分词全部文档。

这是把查询时 CPU 成本前移到导入阶段。只要文档和切块不变，关键词统计也不变，因此没有必要每次服务启动或每次查询都重新计算。

## Float32Array 内存矩阵

- **朴素做法**：`loadVectorStore()` 把每条 embedding 读成 `number[]`，查询时遍历 `number[][]` 做点积。
- **tiny-rag**：加载时把所有向量摊平进一个连续的 `Float32Array`，记录只保留 `embeddingOffset`。点积时按 offset 直接在这块内存上算。

```ts
// 查询热路径只拿一条记录在 Float32Array 里的 offset，不再持有 number[][]。
dotEmbeddingAt(queryEmbedding, store.embeddings, record.embeddingOffset)
```

比 `number[][]` 更紧凑、对重复查询的 CPU 缓存更友好。

这类优化对小知识库体感不明显，但它保护的是增长后的性能曲线。记录数变多时，点积循环会成为查询阶段的固定成本，连续内存布局会更有优势。

## 中间缓存

- **朴素做法**：每次启动都要重新 parse 整个 NDJSON。
- **tiny-rag**：配置 `INTERMEDIATE_DIR` 后，`loadVectorStore()` 把加载结果缓存成 `*.manifest.json` / `*.records.ndjson` / `*.embeddings.f32` 三类文件。manifest 记录原文件路径、大小、mtime、记录数、维度；下次加载若这些一致，直接读二进制 `Float32Array`，跳过 NDJSON parse。

只影响加载速度，不改变向量库格式。

中间缓存是派生物，不是事实源。事实源仍然是 `vector-store.ndjson`；只要原文件大小或 mtime 变化，manifest 不匹配，就会重新从 NDJSON 加载。

## 内存索引复用

- **朴素做法**：B10 的 `query()` 每次都 `loadVectorStore()` + `createRetriever()`。
- **tiny-rag**：HTTP 服务启动时加载一次 retriever，每个 `/query` 复用同一个内存索引；只有 `POST /reload` 才重新加载。CLI 因为是短生命周期进程，仍每次重建——这对调试更直观。

这里体现了“同一核心，不同入口”的价值。HTTP 服务为吞吐复用索引，CLI 为确定性重新加载索引，两者都调用同一套底层函数。

## 原子写入

- **朴素做法**：`writeFile()` 直接写目标路径。写到一半进程退出，或查询服务刚好在读，就会读到半个文件。
- **tiny-rag**：先写临时文件，再 `rename` 到目标路径。rename 在同一文件系统上是原子操作，避免半写入文件被读到。

原子写入是服务化前必须补的保护。只要查询服务可能在导入时读取向量库，直接覆盖目标文件就存在读到半文件的风险。

## 并发与重试

- **朴素做法**：`embed()` 串行发请求，失败直接抛。
- **tiny-rag**：导入按 `EMBED_BATCH_SIZE` 分批，用 `runWithConcurrency()` 按 `INGEST_CONCURRENCY` 控制批间并发；Ollama 单条 embedding 则用 `OLLAMA_EMBED_CONCURRENCY`。HTTP 层有超时（`REQUEST_TIMEOUT_MS`）和重试（`REQUEST_RETRIES`）——4xx 不重试（多半是配置错误），网络错误 / 超时 / 5xx 才重试。

并发和重试要克制。并发过高会压垮本地模型服务或触发远程限流；重试 4xx 只会把配置错误重复几次。tiny-rag 把这些做成参数，是为了让不同 provider 按自己的吞吐调。

## 鉴权与限流

- **朴素做法**：`mini-rag` 本身没有 HTTP 服务，更没有保护。
- **tiny-rag**：`SERVE_AUTH_TOKEN` 提供 Bearer 鉴权，`SERVE_MAX_CONCURRENCY` 限制在途查询数（超过返回 503），请求体限制 1MB。详见[入口章](/tiny-rag/interfaces/)。

## embedding 校验

- **朴素做法**：直接信任 provider 返回的向量。
- **tiny-rag**：`validateEmbeddings()` 检查返回是数组、数量等于输入数、每个都是合法数字数组、维度一致。向量库一旦写入坏向量，查询会表现为「有分数但排序很怪」，排查成本更高——所以在写入前 fail-fast。

校验放在写入前，是把错误拦在最便宜的位置。坏向量一旦进入向量库，后续所有查询都会继承这个问题。

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

:::tip[不必一次实现所有优化]
优化应该跟着瓶颈走，不要为了“看起来工程化”一次全上。常见优先级：先做**正确性校验和原子写入**（防坏数据），再做**导入缓存**（省 embedding 成本），最后在数据量或查询频率上来后做**内存布局和中间缓存**（提速）。在小知识库上，后两类优化的体感几乎为零。
:::

:::note[下一章：后续扩展路线]
最后一章给出扩展落点图：PDF / HTML 解析、查询改写、reranker、工具调用、结构化数据、向量数据库、多轮对话、权限——各自应该落在哪一层，以及为什么不能把它们随意塞进 query 编排或 Prompt。
:::
