---
title: 架构全景
description: 用 tiny-rag 源码说明 RAG 的导入链路、查询链路、分层结构和关键数据流。
---

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

最重要的边界是：`src/` 是可复用库代码，`cli.ts` 和 `serve.ts` 才负责读取 `.env`、打印日志、监听 HTTP、处理进程退出。运行时参数（超时、重试、并发、温度）由 `src/providers/runtime.ts` 解析成结构体，再由入口注入。

这个边界让库 API 可以被测试和外部调用，也避免核心逻辑依赖终端环境。

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
