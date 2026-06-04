# Tiny RAG

> 一个轻量级 TypeScript RAG 内核：把本地 Markdown / 文本文档导入为向量库，再通过 **CLI、HTTP 服务或库 API** 进行检索问答。

[English](./README.md)

核心链路：

```text
documents → chunk → embedding → vector-store.ndjson → retrieval → LLM answer
```

## 快速开始

```bash
pnpm install
cp .env.example .env          # 默认指向本地 LM Studio
# 把知识库文件放进 ./documents（支持 .md / .txt）
pnpm ingest                   # 生成向量库 vector-store.ndjson
pnpm query -- "如何取消订单？"
```

> 默认配置假设本地已运行 LM Studio。要切换到 Ollama / OpenAI / DeepSeek，见 [环境要求](#环境要求) 与 `.env.example`。

## 能力范围

- **文档导入**：递归读取本地 `.md` / `.txt`，按 Markdown 标题和段落切块（支持自定义切块函数）。
- **多 Provider**：LM Studio、Ollama、OpenAI 兼容接口均可生成 embedding。
- **零数据库**：向量库存为本地 NDJSON 文件。
- **混合检索**：向量相似度 + keyword/BM25 融合。
- **两种入口**：CLI 临时调试，或 `serve.ts` 常驻服务复用内存索引。
- **库可复用**：`src/` 是库代码；`cli.ts` / `serve.ts` 是本地入口，不进入 `dist`。

## 环境要求

- Node.js `>=20.19.0`
- 一个 embedding 服务
- 一个 chat completion 服务

默认配置使用 LM Studio：

```text
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LLM_PROVIDER=lmstudio
EMBEDDING_PROVIDER=lmstudio
```

也可以切换到 Ollama / OpenAI / DeepSeek，配置见 `.env.example`。

## 安装

```bash
pnpm install
cp .env.example .env
```

把知识库文件放到默认目录 `./documents`（支持 `.md` / `.txt`，可通过 `DOCUMENT_EXTENSIONS` 修改）。

## 生成向量库

```bash
pnpm ingest    # 读取 DOCUMENTS_DIR，写入 VECTOR_STORE
```

生成的 `vector-store.ndjson` 是本地向量库：第一行是元数据，后续每行是一条 chunk 记录。**修改资料后需要重新运行 `pnpm ingest`。**

## 命令行查询

```bash
pnpm query -- "如何取消订单？"
```

CLI 适合本地调试；正式服务化使用建议启动 [HTTP 服务](#http-服务)。

## HTTP 服务

```bash
pnpm serve     # 默认监听 http://127.0.0.1:8787
```

三个接口：`GET /health`、`POST /query`、`POST /reload`。

**健康检查**（返回记录数、配置的向量库，以及当前 embedding/LLM 模型）

```bash
curl -s http://127.0.0.1:8787/health
```

**查询**

```bash
curl -s http://127.0.0.1:8787/query \
  -H 'content-type: application/json' \
  -d '{"question":"如何取消订单？"}'
```

响应默认包含 `answer`、`hits`、耗时指标和向量库元信息。需要调试完整候选集或上下文时，加上 `includeCandidates` / `includeContext`：

```bash
curl -s http://127.0.0.1:8787/query \
  -H 'content-type: application/json' \
  -d '{"question":"如何取消订单？","includeCandidates":true,"includeContext":true}'
```

请求体还可按需覆盖 `topK`、`minScore`、`perSourceLimit`、`keywordWeight` 和 `prompt`，未提供时回退到环境变量默认值。

**重新加载向量库**（重新 ingest 后无需重启服务）

```bash
curl -s -X POST http://127.0.0.1:8787/reload
```

**鉴权与限制**

- `/query` 与 `/reload` 默认无鉴权。设置 `SERVE_AUTH_TOKEN` 后这两个接口需带 `Authorization: Bearer <token>`——暴露到 localhost 之外前请务必开启。
- `SERVE_MAX_CONCURRENCY`（默认 `4`）限制 `/query` 的在途请求数，超出返回 `503`。
- 请求体超过 `1MB` 返回 `413`；非法 JSON 返回 `400`。

## 库 API

`src/` 提供可复用 API。调用方显式传入 embedding/chat 函数，库代码不读取环境变量、不打印、不退出进程。

```ts
import {
  createChat,
  createEmbedder,
  createRetriever,
  query,
  type EmbeddingConfig,
  type LLMConfig,
} from './src/index';

const embeddingConfig: EmbeddingConfig = {
  provider: 'lmstudio',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'text-embedding-nomic-embed-text-v1.5',
};

const llmConfig: LLMConfig = {
  provider: 'lmstudio',
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'qwen2.5-7b-instruct',
};

const embed = createEmbedder(embeddingConfig);
const chat = createChat(llmConfig);
const retriever = await createRetriever(embeddingConfig, {
  vectorStore: './vector-store.ndjson',
});

const result = await query('如何取消订单？', {
  embeddingConfig,
  llmConfig,
  embed,
  chat,
  retriever,
  topK: 4,
  perSourceLimit: 2,
});

console.log(result.answer);
```

## 常用配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOCUMENTS_DIR` | `./documents` | 待导入文档目录 |
| `SOURCE_ROOT` | `./documents` | `source` 字段的相对路径基准 |
| `DOCUMENT_EXTENSIONS` | `.md,.txt` | 导入扩展名 |
| `VECTOR_STORE` | `./vector-store.ndjson` | 本地向量库文件 |
| `INTERMEDIATE_DIR` | 空 | 可选中间态缓存目录；配置后加速向量库加载，留空则不启用 |
| `CHUNK_SIZE` | `600` | 单个 chunk 目标长度 |
| `CHUNK_OVERLAP` | `80` | 长文本硬切时的重叠长度 |
| `TOP_K` | `4` | 最终返回片段数量 |
| `PER_SOURCE_LIMIT` | `2` | 同一 source 最多进入最终上下文的片段数 |
| `MIN_SCORE` | `0` | 最低分数阈值，`0` 表示不过滤 |
| `KEYWORD_WEIGHT` | `0.3` | keyword/BM25 融合权重 |
| `STREAM` | `1` | CLI 流式输出：`1` 边生成边打印，`0` 等完整答案 |
| `EMBED_BATCH_SIZE` | `32` | ingest 时单次 embedding 请求的批大小 |
| `INGEST_CONCURRENCY` | `1` | ingest 时 embedding 批的并发数（OpenAI 类服务可调到 `2-4`） |
| `REQUEST_TIMEOUT_MS` | `60000` | 单次请求超时（毫秒） |
| `REQUEST_RETRIES` | `2` | 请求失败重试次数（不含首次） |
| `OLLAMA_EMBED_CONCURRENCY` | `4` | Ollama embedding 并发（OpenAI / LM Studio 走批量） |
| `LLM_TEMPERATURE` | `0.2` | LLM 采样温度 |
| `LLM_PROVIDER` | `lmstudio` | 生成模型 provider：`lmstudio` / `ollama` / `openai` / `deepseek` |
| `EMBEDDING_PROVIDER` | `lmstudio` | 嵌入模型 provider：`lmstudio` / `ollama` / `openai` |
| `SERVE_HOST` | `127.0.0.1` | HTTP 服务监听地址 |
| `SERVE_PORT` | `8787` | HTTP 服务端口 |
| `SERVE_AUTH_TOKEN` | 空 | 设置后 `/query` 与 `/reload` 需带 `Authorization: Bearer <token>` |
| `SERVE_MAX_CONCURRENCY` | `4` | `/query` 最大在途请求数，超出返回 `503` |

## 项目结构

```text
src/
  constants/    默认常量
  ingestion/    文档读取、切块、导入向量库
  providers/    LM Studio / Ollama / OpenAI 兼容 provider
  query/        检索、prompt 构造、问答入口
  storage/      本地 NDJSON 向量库读写
  utils/        通用工具
runtime/        CLI / serve 使用的环境变量解析
cli.ts          本地命令行调试入口
serve.ts        HTTP 服务入口
test/           Node test runner 测试
```

## 适用规模

适合个人、本地调试、小团队内部知识库和客服辅助问答。团队人数不是硬上限——真正影响规模的是 **资料切块数量、并发查询数、模型服务吞吐，以及是否具备生产级保护**。

按下面的范围对照判断：

| 场景 | 适合度 | 说明 |
| --- | --- | --- |
| 个人 / 本地调试 | ✅ 适合 | CLI 或 HTTP 服务都可以 |
| 小型内部知识库 | ✅ 适合 | 约 `100 - 1000` 篇资料，`1 - 20 MB` 纯文本 |
| 客服辅助试点 | ✅ 适合 | `10` 人左右可直接试用，低频问答通常 `1 - 3` 并发 |
| 更大的内部团队 | ⚠️ 可扩展 | `20 - 50` 人低并发也行，但建议先加鉴权、日志、限流和错误码 |
| 高并发 / 公网服务 | ❌ 不建议直接用 | 需要队列、监控、审计、权限控制和稳定性治理 |
| 大型知识库 | 🔧 需升级检索层 | 十万级 chunk 建议接向量数据库或 ANN 索引 |

**舒适区间**：`2,000 - 30,000` chunks。这个范围内检索通常不是瓶颈，更常见的瓶颈是 embedding / LLM 服务的响应速度和并发能力。

**优化优先级**（以 `10` 人左右低并发客服为例，无需换成 Go）：服务化常驻 → 加鉴权和限流 → 加请求日志 → 控制模型并发 → 必要时再接向量数据库。

## 构建与测试

```bash
pnpm typecheck       # 类型检查
pnpm test            # Node test runner 测试
pnpm bench           # 性能基准
pnpm build           # 构建库入口到 dist/
```

构建产物只包含库入口：

```text
dist/index.js
dist/index.cjs
dist/src/**/*.d.ts
```

`cli.ts` 和 `serve.ts` 仅用于本地运行，不作为包入口发布。
