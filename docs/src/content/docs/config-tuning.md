---
title: 配置与调参
description: 环境变量分组、切块与检索参数的调参手册，以及推荐排查顺序。
---

tiny-rag 的配置在 `cli.ts` 和 `serve.ts` 读取（`src/providers/runtime.ts` 负责解析运行时参数），核心库本身不读环境变量。这一章是一份调参速查。

## 配置分组

### 文档和向量库

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DOCUMENTS_DIR` | `./documents` | 待导入文档目录 |
| `SOURCE_ROOT` | `./documents` | `source` 字段的相对路径基准 |
| `DOCUMENT_EXTENSIONS` | `.md,.txt` | 导入扩展名 |
| `VECTOR_STORE` | `./vector-store.ndjson` | 本地向量库文件 |
| `INTERMEDIATE_DIR` | 空 | 向量库加载中间缓存目录 |

### 切块和导入

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHUNK_SIZE` | `600` | chunk 目标长度 |
| `CHUNK_OVERLAP` | `80` | 长文本硬切时的重叠长度 |
| `HEADING_WEIGHT` | `2` | embedding 文本中标题重复权重 |
| `EMBED_BATCH_SIZE` | `32` | OpenAI 兼容 embedding 批大小 |
| `INGEST_CONCURRENCY` | `1` | embedding 批并发 |

### 检索

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `TOP_K` | `4` | 最终进入上下文的片段数 |
| `PER_SOURCE_LIMIT` | `2` | 同一 source 最多命中数 |
| `MIN_SCORE` | `0` | 最低分数阈值 |
| `KEYWORD_WEIGHT` | `0.3` | keyword/BM25 融合权重 |
| `KEYWORD_HEADING_WEIGHT` | `2` | BM25 标题权重 |

### 模型运行时

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `REQUEST_TIMEOUT_MS` | `60000` | 单次请求超时 |
| `REQUEST_RETRIES` | `2` | 请求失败重试次数 |
| `OLLAMA_EMBED_CONCURRENCY` | `4` | Ollama embedding 并发 |
| `LLM_TEMPERATURE` | `0.2` | 聊天模型温度 |
| `STREAM` | `1` | CLI 是否流式输出 |

### HTTP 服务

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `SERVE_HOST` | `127.0.0.1` | 监听地址 |
| `SERVE_PORT` | `8787` | 监听端口 |
| `SERVE_AUTH_TOKEN` | 空 | 查询和 reload 鉴权 |
| `SERVE_MAX_CONCURRENCY` | `4` | 最大在途查询数 |

## 切块参数

**chunk 太大**（一个片段混了多个主题，回答被无关内容干扰）：调小 `CHUNK_SIZE=400`，并保留适当 `CHUNK_OVERLAP=60`。

**chunk 太小**（片段只有半句话，模型拿不到完整条件）：调大 `CHUNK_SIZE=800`、`CHUNK_OVERLAP=120`。注意 `CHUNK_OVERLAP` 必须小于 `CHUNK_SIZE`。

## 检索参数

**TopK 太小**（正确资料在候选里但没进上下文）：调大 `TOP_K=6`。

**TopK 太大**（上下文变长、无关片段变多、回答开始混淆规则）：调小 `TOP_K=3`。

**关键词权重**：查询含专有名词、短中文词、产品名、编号时调高 `KEYWORD_WEIGHT=0.45`；偏自然语言语义表达、关键词干扰多时调低 `KEYWORD_WEIGHT=0.15`。

**最低分数**：知识库没答案时仍召回弱相关片段，可设 `MIN_SCORE=0.25`。不同 embedding 模型分数分布不同，先观察几次实际 `score` 再设阈值，别一开始就设太高。

## 换模型后重新 ingest

改了 embedding provider 或 embedding model 就必须重新导入。这些变量变化都需要重建向量库：

```text
EMBEDDING_PROVIDER
LMSTUDIO_EMBEDDING_MODEL
OLLAMA_EMBEDDING_MODEL
OPENAI_EMBEDDING_MODEL
```

聊天模型变化不要求重新导入，因为向量库只依赖 embedding 模型。

## 推荐排查顺序

1. 确认资料里真的写了答案。
2. 重新运行 `pnpm ingest`。
3. 用 `pnpm query` 看命中表格。
4. 如果 source 错，优先调文档标题、切块和关键词权重。
5. 如果 source 对但回答错，再看 Prompt 和模型。
6. 如果服务慢，再看 `INTERMEDIATE_DIR`、模型吞吐和并发配置。

> 不要一上来就改 Prompt。RAG 的问题大多先出在召回阶段。
