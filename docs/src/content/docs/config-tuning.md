---
title: 配置与检索调参
description: 按现象理解 tiny-rag 的切块、检索、模型和服务参数，建立可复现的 RAG 调参顺序。
---

tiny-rag 的配置在 `cli.ts` 和 `serve.ts` 读取（`runtime/env.ts` 负责环境变量类型解析，`src/providers/runtime.ts` 负责 provider 运行参数的默认值和校验），核心库本身不读环境变量。这一章是一份调参速查。

调 RAG 不应该从“把所有参数试一遍”开始。更有效的方式是先看现象：召回不到、命中了但答案错、服务慢、模型请求不稳，分别对应不同参数。参数表只是索引，真正的顺序是先定位问题属于导入、检索、生成还是运行时。

> **工程化阶段**：先看现象定位到层，再查对应参数，一次只改一个。

:::note[本章目标]
这一章是**速查 + 排查顺序**，不必从头背到尾。建议先记住一个原则：**先看现象定位到层，再查对应参数**。下面的“现象 → 该调什么”小节，比参数表更适合实际调参时翻阅。
:::

## 调参前先收集证据

每次调参前，先打开或记录这些字段：

| 字段 | 用来判断 |
| --- | --- |
| `candidates` | 正确片段是否被检索器排进候选池 |
| `hits` | 正确片段是否最终进入 Prompt |
| `vectorScore` | 语义相似信号是否强 |
| `keywordScore` | 字面命中信号是否强 |
| `context` | 模型真正看到的参考内容是否干净 |
| `meta` | 向量库是否来自当前 embedding 模型和 chunk 参数 |
| `embeddingElapsedMs` / `searchElapsedMs` / `generationElapsedMs` | 慢在 embedding、检索还是生成 |

没有这些证据，调参很容易变成猜。更完整的排查方法见 [诊断与解析方法](/tiny-rag/diagnostics/)；本章只负责把定位后的问题映射到具体配置。

## 配置分组

### 文档和向量库

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DOCUMENTS_DIR` | `./documents` | 待导入文档目录 |
| `SOURCE_ROOT` | `./documents` | `source` 字段的相对路径基准 |
| `DOCUMENT_EXTENSIONS` | `.md,.txt` | 导入扩展名 |
| `VECTOR_STORE` | `./vector-store.ndjson` | 本地向量库文件 |
| `INTERMEDIATE_DIR` | 空 | 向量库加载中间缓存目录 |

这组参数改变的是输入和索引位置。改了文档目录、扩展名或 source 基准后，最好重新 `pnpm ingest` 并观察命中表，确认 source 是否符合预期。

### 切块和导入

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHUNK_SIZE` | `600` | chunk 目标长度 |
| `CHUNK_OVERLAP` | `80` | 长文本硬切时的重叠长度 |
| `HEADING_WEIGHT` | `2` | embedding 文本中标题重复权重 |
| `EMBED_BATCH_SIZE` | `32` | OpenAI 兼容 embedding 批大小 |
| `INGEST_CONCURRENCY` | `1` | embedding 批并发 |

切块参数影响召回上限，导入参数影响构建成本。`HEADING_WEIGHT` 依赖文档标题质量：标题清楚时有帮助，标题泛泛时不要指望它修复正文混乱。

### 检索

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `TOP_K` | `4` | 最终进入上下文的片段数 |
| `PER_SOURCE_LIMIT` | `2` | 同一 source 最多命中数 |
| `MIN_SCORE` | `0` | 最低分数阈值 |
| `KEYWORD_WEIGHT` | `0.3` | keyword/BM25 融合权重 |
| `KEYWORD_HEADING_WEIGHT` | `2` | BM25 标题权重 |

检索参数最好在 CLI 下调，因为 CLI 会直接打印命中片段。先让正确 source 进入 hits，再讨论回答质量。不要在命中错误时先改 Prompt。

### 模型运行时

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `REQUEST_TIMEOUT_MS` | `60000` | 单次请求超时 |
| `REQUEST_RETRIES` | `2` | 请求失败重试次数 |
| `OLLAMA_EMBED_CONCURRENCY` | `4` | Ollama embedding 并发 |
| `LLM_TEMPERATURE` | `0.2` | 聊天模型温度 |
| `STREAM` | `1` | CLI 是否流式输出 |

模型运行时参数主要处理稳定性和生成风格。embedding 请求失败、超时、吞吐低，优先看 timeout、retry 和并发；回答太发散，再看 `LLM_TEMPERATURE`。

### HTTP 服务

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `SERVE_HOST` | `127.0.0.1` | 监听地址 |
| `SERVE_PORT` | `8787` | 监听端口 |
| `SERVE_AUTH_TOKEN` | 空 | 查询和 reload 鉴权 |
| `SERVE_MAX_CONCURRENCY` | `4` | 最大在途查询数 |

HTTP 服务参数是部署边界。默认 localhost 适合本机调试；只要暴露给其他机器，就应该配置 token，并根据模型服务能力设置并发上限。

## 切块参数

**chunk 太大**（一个片段混了多个主题，回答被无关内容干扰）：调小 `CHUNK_SIZE=400`，并保留适当 `CHUNK_OVERLAP=60`。

**chunk 太小**（片段只有半句话，模型拿不到完整条件）：调大 `CHUNK_SIZE=800`、`CHUNK_OVERLAP=120`。注意 `CHUNK_OVERLAP` 必须小于 `CHUNK_SIZE`。

切块调参要配合原文结构看。Markdown 标题清楚、段落自然时，不需要频繁调 size；如果文档本身是长段落、表格文本或从 PDF 抽出来的碎文本，固定长度兜底会更多介入，size 和 overlap 的影响也会更明显。

## 检索参数

**TopK 太小**（正确资料在候选里但没进上下文）：调大 `TOP_K=6`。

**TopK 太大**（上下文变长、无关片段变多、回答开始混淆规则）：调小 `TOP_K=3`。

**关键词权重**：查询含专有名词、短中文词、产品名、编号时调高 `KEYWORD_WEIGHT=0.45`；偏自然语言语义表达、关键词干扰多时调低 `KEYWORD_WEIGHT=0.15`。

**最低分数**：知识库没答案时仍召回弱相关片段，可设 `MIN_SCORE=0.25`。不同 embedding 模型分数分布不同，先观察几次实际 `score` 再设阈值，别一开始就设太高。

`MIN_SCORE` 是防止“硬答”的保险，不是提升召回的工具。阈值太高会把本来有用的片段挡掉；阈值太低则等于没有兜底。先收集一批有答案和无答案问题的分数，再决定阈值。

## 换模型后重新 ingest

改了 embedding provider 或 embedding model 就必须重新导入。这些变量变化都需要重建向量库：

```text
EMBEDDING_PROVIDER
LMSTUDIO_EMBEDDING_MODEL
OLLAMA_EMBEDDING_MODEL
OPENAI_EMBEDDING_MODEL
```

聊天模型变化不要求重新导入，因为向量库只依赖 embedding 模型。

:::caution[改了这些就必须重建向量库]
**改了就必须 `pnpm ingest` 重建**：`EMBEDDING_PROVIDER`、各 provider 的 embedding model、`CHUNK_SIZE`、`CHUNK_OVERLAP`。原因是它们会改变向量本身或 chunk 边界，旧向量库的 `_meta` 校验会直接失败。
**改了不用重建**：`LLM_TEMPERATURE`、聊天模型、`TOP_K`、`KEYWORD_WEIGHT`、`MIN_SCORE` 等查询期参数——它们只影响检索排序和生成，不动向量库。
:::

如果只改了 `LLM_TEMPERATURE` 或聊天模型，不需要重新 ingest；如果改了 `CHUNK_SIZE`、`CHUNK_OVERLAP`、embedding provider 或 embedding model，就应该把向量库当作旧索引重建。

## 推荐排查顺序

1. 确认资料里真的写了答案。
2. 重新运行 `pnpm ingest`。
3. 用 `pnpm query` 看命中表格，调试接口时打开 `includeCandidates` / `includeContext`。
4. 如果正确片段不在 `candidates`，优先看文档标题、切块、embedding 模型和关键词权重。
5. 如果正确片段在 `candidates` 但不在 `hits`，看 `TOP_K` 和 `PER_SOURCE_LIMIT`。
6. 如果 `hits` 对但回答错，再看 Prompt、温度和聊天模型。
7. 如果服务慢，再看 `INTERMEDIATE_DIR`、模型吞吐、并发配置和耗时字段。

:::caution[不要一上来就改 Prompt]
新手最常见的弯路：回答不对，第一反应是改 system prompt。但 RAG 的问题**大多先出在召回阶段**——命中片段里根本没有答案，再怎么改 Prompt 模型也变不出证据。正确顺序是先看命中表（`source` 对不对、`score` 高不高），确认召回正确后，再去调 Prompt 和模型。
:::

一个实用的调参循环是：固定一组代表性问题，记录命中 source、score、最终答案，然后一次只改一个参数。否则很难判断结果变好是因为 chunk、关键词权重、TopK 还是模型随机性。

## 本章小结

- 调参顺序：**先看现象定位到层**（导入 / 检索 / 生成 / 运行时），再查对应参数，一次只改一个。
- 召回不到 → 调 `TOP_K`、`CHUNK_SIZE`、`KEYWORD_WEIGHT`；命中了但答错 → 才看 Prompt 和模型。
- 改 embedding model 或切块参数**必须重建向量库**；改聊天模型或查询参数不用。
- `MIN_SCORE` 是“防硬答”的保险，不是提升召回的工具，阈值要根据实际分数分布来定。

:::note[下一章：工程优化如何工作]
配置讲完了，下一章逐项对照 mini-rag 的朴素实现，看 tiny-rag 在同一条链路上加了哪些工程优化——增量缓存、内存索引、原子写入、并发重试，以及它们各自解决什么问题。
:::
