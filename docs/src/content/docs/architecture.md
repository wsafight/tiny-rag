---
title: 工作流与源码架构
description: 从分层边界、导入生命周期和查询生命周期三个角度，深度解读 tiny-rag 的 RAG 架构。
---

读 RAG 源码时，不要先盯着某个 provider 或某个 Prompt。更稳的方式是先抓住两条流水线：导入阶段如何把文件变成向量库，查询阶段如何把问题变成答案。所有模块都可以放回这两条线里解释。

> **理解阶段**：动手写代码前，先看清数据在导入和查询两条线上怎么流动。

tiny-rag 的架构故意保持克制：入口负责环境，核心库负责纯逻辑，存储和检索之间用明确的数据结构连接。这让它既适合阅读，也留下了替换 provider、向量库和入口形态的空间。

:::note[本章目标]
读完这一章，你会有一张“架构地图”：知道代码分成哪几层、**导入**和**查询**两条流水线各经过哪些函数、向量库文件长什么样，以及 CLI / HTTP / 库三种入口的区别。后面 `B01`–`B10` 写的每一段代码，都能在这张地图上找到位置。
:::

## 分层结构

```text
使用入口
  cli.ts / serve.ts / library API
        |
        v
RAG 核心库
  ingestion/    providers/    query/    storage/
        |
        v
基础工具
  utils/        constants/    types
```

最重要的边界是：`src/` 是可复用库代码，`cli.ts` 和 `serve.ts` 才负责读取 `.env`、打印日志、监听 HTTP、处理进程退出。环境变量类型解析在 `runtime/env.ts`，provider 运行参数（超时、重试、并发、温度）的默认值和校验在 `src/providers/runtime.ts`，最后由入口注入核心库。

这个边界让库 API 可以被测试和外部调用，也避免核心逻辑依赖终端环境。

这里的关键不是“目录分得整齐”，而是副作用被关在入口层。读取 `.env`、打印日志、监听端口、退出进程，都会让代码难测试；把这些留在 `cli.ts` / `serve.ts`，`src/` 里的函数就可以像普通库一样被单元测试、脚本和 HTTP 服务复用。

## 导入生命周期

入口是 `ingest(options)`，位于 `src/ingestion/ingest.ts`。

```text
loadDocuments()
  |
  v
buildChunkRecords()
  |
  v
readEmbeddingCache()
  |
  v
embed pending chunks
  |
  v
normalize vectors
  |
  v
writeVectorStore()
```

关键点：

- `loadDocuments()` 递归读取文档，并把 source 转成可移植的 POSIX 相对路径。
- `splitSemantic()` 先按 Markdown 标题切分，再按空行聚合段落。
- `buildEmbeddingText()` 会重复标题，提升标题在 embedding 文本中的权重。
- 每个 chunk 生成 `hash`，未变化的 chunk 可以复用旧 embedding。
- 写向量库时先写临时文件，再 rename，避免半写入文件被查询端读到。

导入阶段本质上是一次“索引构建”。它应该尽量可重复：同一批文档、同一组切块参数、同一个 embedding 模型，应该得到同一组 chunk 和同一个向量空间。只有这个前提成立，hash 缓存、指纹跳过和向量库校验才有意义。

## 查询生命周期

入口是 `query(question, options)`，位于 `src/query/query.ts`。

```text
trim question
  |
  v
embed(question)
  |
  v
retriever.search()
  |
  v
selectDiverseHits()
  |
  v
buildContext()
  |
  v
buildMessages()
  |
  v
chat(messages)
```

查询阶段有两个可变点：

- 可以传入已经加载好的 `retriever`，适合 HTTP 服务复用内存索引。
- 可以传入自定义 `buildMessages()`，替换默认 Prompt 构造方式。

查询阶段的核心判断是：不要把“召回”和“生成”混在一起。召回失败时，改 Prompt 通常没有用；命中片段正确但回答跑偏时，才应该看 system prompt、模型温度和聊天模型能力。这个分离能大幅降低排查成本。

:::tip[排查 RAG 的第一原则]
回答不对时，先分清是**召回问题**还是**生成问题**。召回问题表现为“命中片段里根本没有答案”，要去查切块、embedding、检索参数；生成问题表现为“片段里有答案但模型答错”，才去看 Prompt 和模型。这条原则会在后面多个章节反复出现。
:::

### candidates 与 hits

真实源码里，查询结果会区分 `candidates` 和 `hits`：

```text
retriever.search()
  -> candidates
  -> selectDiverseHits()
  -> hits
  -> buildContext()
```

`candidates` 是检索器按融合分数排出的候选池。它回答“哪些片段和问题最相关”。`hits` 是经过 `TOP_K` 和 `PER_SOURCE_LIMIT` 之后真正进入 Prompt 的片段。它回答“最终让模型看到哪些证据”。

这两个字段分开，是为了让排查更精确：如果正确片段在 `candidates` 里但没进 `hits`，优先看同源限制和 TopK；如果正确片段连 `candidates` 都没有进，才回到切块、embedding、关键词分数和向量库 meta。

`query()` 还会返回 `embeddingElapsedMs`、`searchElapsedMs`、`retrievalElapsedMs` 和 `generationElapsedMs`。这些耗时不是装饰字段：embedding 慢说明模型服务或网络慢，search 慢可能是向量库加载/点积成本，generation 慢则是聊天模型输出成本。把耗时拆开，才能知道应该优化 provider、retriever 还是 LLM。

## 向量库结构

`vector-store.ndjson` 是一个本地 NDJSON 文件。

第一行是元数据：

```json
{
  "_meta": {
    "version": 1,
    "provider": "lmstudio",
    "model": "text-embedding-nomic-embed-text-v1.5",
    "dim": 768,
    "chunkSize": 600,
    "chunkOverlap": 80,
    "createdAt": "2026-06-05T00:00:00.000Z"
  }
}
```

后续每一行是一条 chunk：

```json
{
  "id": "faq.md#0",
  "source": "faq.md",
  "chunkIndex": 0,
  "heading": "订单问题 > 取消订单",
  "content": "订单支付后...",
  "embedding": [0.0123, -0.0456],
  "hash": "..."
}
```

读取时 `validateVectorStoreMeta()` 会校验版本、provider、model、dim 和切块参数。这个校验很重要，因为不同 embedding 模型的向量不能混用。

`_meta` 可以看作向量库的契约。没有它，文件里那一长串数字没有语义：你不知道维度从哪来、模型是谁、切块参数是什么，也不知道当前查询向量能不能和它比较。

:::caution[换了 embedding 模型，必须重建向量库]
向量库里的数字只在“同一个 embedding 模型”的坐标系里有意义。一旦换了 embedding provider 或 model，旧向量就失去了比较意义，必须重新 `ingest`。这是 RAG 最常见的“看起来能跑但结果全乱”的坑。换**聊天模型**则不需要重建，因为向量库只依赖 embedding 模型。
:::

## 运行入口

### CLI

`cli.ts` 支持：

```bash
pnpm ingest
pnpm query -- "你的问题"
```

CLI 每次查询都会读取配置、创建 embed/chat 函数、加载 retriever，再执行一次 `query()`。它适合本地调试。

### HTTP 服务

`serve.ts` 支持：

```bash
pnpm serve
```

启动时先加载向量库并创建 `retriever`，之后 `/query` 请求复用这个内存索引。修改资料并重新导入后，可以调用 `POST /reload` 重新加载向量库，不需要重启服务。

### 库 API

`src/index.ts` 导出核心函数。调用方显式传入 `embed`、`chat`、`embeddingConfig`、`llmConfig`，库代码不读取环境变量。

## 关键设计

| 设计 | 作用 |
| --- | --- |
| `src/` 与入口隔离 | 核心逻辑可测试、可复用 |
| NDJSON 向量库 | 简单、透明、便于调试 |
| `_meta` 强校验 | 防止不同 embedding 空间混用 |
| hash 缓存 | 文档局部修改时减少 embedding 成本 |
| `Float32Array` 中间缓存 | HTTP 服务加载大向量库更快 |
| 混合检索 | 兼顾语义相似和关键词精确命中 |
| `selectDiverseHits()` | 避免单一文件垄断上下文 |

从源码阅读角度看，可以把这些设计分成三类：**正确性边界**（meta 校验、入口隔离）、**成本优化**（hash 缓存、Float32Array、中间缓存）、**召回质量**（语义切块、混合检索、同源限制）。读任何一个函数时，先判断它属于哪一类，理解会快很多。

## 本章小结

- 整个系统围绕两条流水线：**导入**（`loadDocuments → buildChunkRecords → embed → writeVectorStore`）和**查询**（`embed(question) → retriever.search → buildContext → chat`）。
- 分层的关键不是“目录整齐”，而是**副作用被关在入口层**：`src/` 是纯逻辑，`.env`、日志、HTTP 都在 `cli.ts` / `serve.ts`。
- 向量库 `_meta` 是一份契约，保证查询向量和库里的向量来自同一个 embedding 空间。
- 三种入口共享同一套核心：CLI 短进程重确定性，HTTP 长进程复用内存索引，库 API 不假设运行环境。

:::note[继续阅读]
地图已经画好。下一章 [B01：项目骨架与核心类型](/tiny-rag/build-01-skeleton/) 开始动手，从一个空目录搭起 `mini-rag`，先用 TypeScript 类型把上面这两条流水线“钉”下来。
:::
