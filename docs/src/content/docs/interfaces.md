---
title: "三种入口：CLI / HTTP / 库 API"
description: 从进程生命周期看 tiny-rag 的三种入口，理解调试、服务化和库复用的边界。
---

`mini-rag` 的 `main.ts` 是个写死配置的入口。真实项目需要三种入口：本地命令行调试、常驻 HTTP 服务、以及给别的程序调用的库 API。tiny-rag 把 `src/` 作为纯核心库，`cli.ts` 和 `serve.ts` 负责把它接到具体运行环境。

> **工程化阶段**：同一套核心库，三种生命周期。

核心边界：**`src/` 接收显式参数、返回结构化结果，不读环境变量、不打印、不退出进程。** 这条边界让库 API 可测试、可复用。

这一章关注的不是“怎么多写几个入口”，而是同一套 RAG 核心逻辑在不同生命周期里应该怎样运行。CLI 是短进程，适合调试；HTTP 是长进程，适合复用内存索引；库 API 是无入口假设的核心能力，适合被外部系统编排。

:::note[本章目标]
读完这一章，你能根据**场景**选对入口：什么时候用 CLI、什么时候起 HTTP 服务、什么时候直接调库 API。核心是理解三者共享同一套 `src/` 核心，区别只在“生命周期”和“谁来提供配置”。
:::

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

短生命周期的代价是重复加载，但好处是状态少。调试 RAG 时，确定性往往比性能更重要：你改一份文档、重跑 ingest、再 query，一眼就能看到新结果。CLI 不适合高频服务，但非常适合观察命中片段和参数变化。

### 流式输出

默认 `STREAM=1`。开启时 CLI 先在检索回调里打印命中表格，再通过流式逐 token 输出答案。要把输出重定向给其它工具时设 `STREAM=0`，等完整回答再打印。

命中表格比最终回答更有排障价值。如果答案错但命中片段对，问题多半在 Prompt 或聊天模型；如果命中片段错，应该回到切块、embedding、关键词权重和 TopK。

## HTTP 服务

`serve.ts` 负责启动 server、**启动时加载一次 retriever**、复用内存索引处理查询、提供健康检查 / 查询 / reload，并处理鉴权、并发限制、请求体大小限制。

默认监听 `http://127.0.0.1:8787`。

HTTP 服务和 CLI 最大的差异是缓存生命周期。服务启动时加载向量库，把检索器留在内存里；每次 `/query` 只做问题 embedding、检索和聊天生成。对重复查询来说，这比每次从磁盘重新 parse NDJSON 更合理。

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

调试建议分两档：

- 平时只看 `answer`、`hits` 和耗时，响应更轻。
- 排查召回时打开 `includeCandidates` 和 `includeContext`，对比“候选池里有什么”和“最终喂给模型什么”。

如果正确片段在 `candidates` 里但不在 `hits`，问题通常在 `TOP_K` 或 `PER_SOURCE_LIMIT`；如果连 `candidates` 都没有，回到导入、切块、embedding 和关键词参数。

### POST /reload

```bash
curl -s -X POST http://127.0.0.1:8787/reload
```

先 `pnpm ingest` 更新向量库，再 reload 让服务刷新内存索引，无需重启。

`/reload` 的存在说明导入和服务不是同一个动作。导入负责生成新的向量库文件，服务负责读取并使用它。把这两个动作分开，才能避免正在查询时读到半更新状态，也方便在部署流程里单独控制。

## 鉴权

默认 `/query` 和 `/reload` 无鉴权，只适合 localhost。设置 `SERVE_AUTH_TOKEN` 后，请求需携带 `Authorization: Bearer <token>`。

:::danger[不要把未鉴权服务暴露到公网]
默认配置没有鉴权，只能绑在 `127.0.0.1` 本机调试用。一旦监听到 `0.0.0.0` 或映射到公网，任何人都能调用你的 `/query`：既会消耗你的模型调用成本，也可能把整个知识库内容读走。对外提供服务前，**务必**设置 `SERVE_AUTH_TOKEN`，并配合并发限制和请求体限制。
:::

## 并发限制

`SERVE_MAX_CONCURRENCY`（默认 4）限制 `/query` 的在途请求数，超过返回 `503 服务繁忙`。这保护的是模型服务和本进程，不是完整限流系统，但对本地或小团队服务已有实际价值。

## 请求体限制

请求体最大 1MB，超过返回 `413`，JSON 解析失败返回 `400`。这类保护防止最基本的误用。

## 库 API

`src/index.ts` 导出核心函数，调用方显式传入 `embed`、`chat`、`embeddingConfig`、`llmConfig`，库代码不读环境变量。这让同一套核心逻辑能被 CLI、HTTP 服务、单元测试和外部程序复用。

库 API 是整个架构里最干净的层。它不假设终端存在，不假设 HTTP 请求存在，也不假设配置来自 `.env`。外部系统可以把 tiny-rag 嵌进自己的任务队列、桌面应用或后端服务，只要显式传入依赖。

## 怎么选

| 场景 | 建议 |
| --- | --- |
| 调试文档、观察命中片段 | CLI |
| 接给前端或内部工具 | HTTP |
| 批处理脚本 | 库 API 或 CLI |
| 长期运行服务 | HTTP |
| 单元测试 | 库 API |

选择入口时先看生命周期，而不是看功能多少：一次性运行选 CLI，重复查询选 HTTP，想把 RAG 能力嵌进别的程序选库 API。三个入口共享同一套核心逻辑，所以调通 CLI 后，再服务化不会换一套实现。

## 本章小结

- 三种入口共享 `src/` 核心，区别在生命周期：**CLI 短进程重确定性**，**HTTP 长进程复用内存索引**，**库 API 不假设运行环境**。
- HTTP 服务启动时加载一次 retriever，`/query` 复用，`POST /reload` 才刷新——导入和服务是两个独立动作。
- 安全三件套：`SERVE_AUTH_TOKEN` 鉴权、`SERVE_MAX_CONCURRENCY` 并发限制、1MB 请求体上限。
- 库 API 最干净：显式传入 `embed` / `chat` / 配置，可嵌进任务队列、桌面应用或后端服务。

:::note[下一章：配置与检索调参]
入口讲清楚了，下一章是一份**按现象排查**的调参速查：召回不到、命中了但答错、服务慢，分别该调哪些参数，以及为什么不要一上来就改 Prompt。
:::
