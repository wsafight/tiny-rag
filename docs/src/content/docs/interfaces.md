---
title: "入口：CLI / HTTP / 库 API"
description: tiny-rag 如何把核心库包装成本地调试、常驻服务和可被外部调用的库 API。
---

`mini-rag` 的 `main.ts` 是个写死配置的入口。真实项目需要三种入口：本地命令行调试、常驻 HTTP 服务、以及给别的程序调用的库 API。tiny-rag 把 `src/` 作为纯核心库，`cli.ts` 和 `serve.ts` 负责把它接到具体运行环境。

核心边界：**`src/` 接收显式参数、返回结构化结果，不读环境变量、不打印、不退出进程。** 这条边界让库 API 可测试、可复用。

## CLI

`cli.ts` 负责读命令行参数、从 `.env` 读配置、创建 `embed`/`chat`、调用 `ingest()` 或 `query()`、打印进度和结果。

```bash
pnpm ingest
pnpm query -- "你的问题"
```

没有问题参数时，`query` 会尝试从 stdin 或交互输入读取。

### 为什么每次都重新加载

CLI 是短生命周期进程，每次 `pnpm query` 都走一遍：

```text
读取 env → createEmbedder() → createChat() → createRetriever() → query() → 退出
```

这对调试很直观：改了 `.env` 或重新导入向量库，下次命令自然用新配置。

### 流式输出

默认 `STREAM=1`。开启时 CLI 先在检索回调里打印命中表格，再通过流式逐 token 输出答案。要把输出重定向给其它工具时设 `STREAM=0`，等完整回答再打印。

## HTTP 服务

`serve.ts` 负责启动 server、**启动时加载一次 retriever**、复用内存索引处理查询、提供健康检查 / 查询 / reload，并处理鉴权、并发限制、请求体大小限制。

默认监听 `http://127.0.0.1:8787`。

### GET /health

```json
{
  "ok": true,
  "vectorStore": "./vector-store.ndjson",
  "records": 128,
  "embedding": "lmstudio/text-embedding-nomic-embed-text-v1.5",
  "llm": "lmstudio/qwen2.5-7b-instruct"
}
```

### POST /query

```json
{
  "question": "如何取消订单？",
  "topK": 4,
  "includeCandidates": true,
  "includeContext": true
}
```

返回包括 `answer`、`hits`、各阶段耗时和向量库 `meta`。`includeCandidates` / `includeContext` 默认关闭，调试时再打开。

### POST /reload

```bash
curl -s -X POST http://127.0.0.1:8787/reload
```

先 `pnpm ingest` 更新向量库，再 reload 让服务刷新内存索引，无需重启。

## 鉴权

默认 `/query` 和 `/reload` 无鉴权，只适合 localhost。设置 `SERVE_AUTH_TOKEN` 后，请求需携带 `Authorization: Bearer <token>`。

> 不要把未鉴权服务暴露到公网。RAG 查询会调用模型服务，既有成本风险，也可能泄露知识库内容。

## 并发限制

`SERVE_MAX_CONCURRENCY`（默认 4）限制 `/query` 的在途请求数，超过返回 `503 服务繁忙`。这保护的是模型服务和本进程，不是完整限流系统，但对本地或小团队服务已有实际价值。

## 请求体限制

请求体最大 1MB，超过返回 `413`，JSON 解析失败返回 `400`。这类保护防止最基本的误用。

## 库 API

`src/index.ts` 导出核心函数，调用方显式传入 `embed`、`chat`、`embeddingConfig`、`llmConfig`，库代码不读环境变量。这让同一套核心逻辑能被 CLI、HTTP 服务、单元测试和外部程序复用。

## 怎么选

| 场景 | 建议 |
| --- | --- |
| 调试文档、观察命中片段 | CLI |
| 接给前端或内部工具 | HTTP |
| 批处理脚本 | 库 API 或 CLI |
| 长期运行服务 | HTTP |
| 单元测试 | 库 API |
