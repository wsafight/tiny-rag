# 第五步：调试和调参

RAG 出错时，先看检索结果，不要一上来就改 prompt。

## 先看检索结果

查询时脚本会打印：

```text
Retrieved Context (top 4)
-------------------------
  #  score   chunk  source                  heading
  1  0.8123  2      my-notes/membership.md  会员与优惠规则 > 生日券
```

- `score` 是经过 L2 归一化后的点积，等价于 cosine 相似度，范围 [-1, 1]，越接近 1 越相关。
- `heading` 是该 chunk 在原文中所属的多级标题路径，便于你快速回到原文核对。

如果检索结果没有召回正确资料，模型回答通常也不会可靠。

## 常见问题

### 资料里没有答案

这是最常见情况。RAG 不会自动拥有知识库之外的事实。把答案补进 `my-notes/`，再运行：

```bash
npm run ingest
```

得益于内容 hash 缓存，未变动的 chunk 会复用旧向量，只有新增/修改的部分会重新调用 embedding。

### chunk 太大

一个 chunk 里混了太多主题，检索会不聚焦。可以调小：

```text
CHUNK_SIZE=400
```

### chunk 太小

一个 chunk 只有半句话或半个流程，模型拿不到完整依据。可以调大：

```text
CHUNK_SIZE=800
```

> 现在切块是"语义优先 + 长度兜底"：先按 Markdown 标题分节、按空行聚合段落，最后才按 `CHUNK_SIZE` 硬切。所以即使 `CHUNK_SIZE` 设得偏大，多数 chunk 也不会越过标题边界。

### topK 太小

相关资料没有进上下文。可以调大：

```text
TOP_K=6
```

### topK 太大

上下文太乱，模型被无关资料干扰。可以调小：

```text
TOP_K=3
```

### 召回了不相关的"凑数"片段

即使资料里没有答案，向量检索仍会返回 Top-K 中相似度较低的片段，模型容易被带偏。可以打开最低相似度阈值：

```text
MIN_SCORE=0.3
```

- 所有片段都被过滤时，脚本会直接回答"我不知道"，而不是让模型瞎猜。
- 不同 embedding 模型的分数分布不同，建议先观察几次实际 `score`，再设阈值。常见区间：
  - `text-embedding-3-small` / `nomic-embed-text`: 通常 0.25 ~ 0.45 起判。
  - 中文模型分数普遍偏低，可适当下调。

### chunk overlap 调整

相邻 chunk 之间会保留一段重叠（`CHUNK_OVERLAP`），避免答案刚好被切断在边界。

- 建议设为 `CHUNK_SIZE` 的 10–20%（默认 size=600 时 overlap=80）。
- 必须满足 `CHUNK_OVERLAP < CHUNK_SIZE`，否则切块无法向前推进。
- overlap 太大只会增加冗余 chunk，并不会提升召回。

### 换了 embedding 模型却没重新 ingest

`vector-store.ndjson` 第一行的 `_meta` 记录了 `version / provider / model / dim`，`src/query.js` 启动时会校验：

- `version` 不一致 → 直接报错退出，提示重新 `npm run ingest`。
- `provider` 不一致 → 直接报错退出，提示重新 `npm run ingest`。
- `model` 不一致 → 直接报错退出，提示重新 `npm run ingest`。
- `dim` 不一致 → 直接报错退出，说明问题向量和向量库不是同一套 embedding。

这是故意设计成“直接停下来”的。不同 embedding 模型生成的向量不能混在一起比较；继续运行只会得到看起来有分数、实际不可靠的检索结果。

### `.env` 写错了

现在脚本启动时会检查常见配置值。比如：

```text
TOP_K=abc
CHUNK_OVERLAP=600
CHUNK_SIZE=400
STREAM=maybe
```

这些都会直接报错，而不是继续运行。

常见处理方式：

- 数字配置只写数字，比如 `TOP_K=4`。
- `CHUNK_OVERLAP` 必须小于 `CHUNK_SIZE`。
- `STREAM` 只能写 `1/0`、`true/false`、`on/off` 或 `yes/no`。
- 改了 embedding provider 或 embedding model 后，重新运行 `npm run ingest`。

### 本地服务偶尔卡住 / 超时

`src/providers.js` 已经内置：

- `REQUEST_TIMEOUT_MS`：单次请求超时（默认 60s），超时后会被中断。
- `REQUEST_RETRIES`：失败时的指数退避重试次数（默认 2 次）。4xx 不重试，5xx / 网络错误才重试。
- `OLLAMA_EMBED_CONCURRENCY`：Ollama 原生 embedding 接口一次只接受一条文本，这里通过有限并发批量发起。

需要时在 `.env` 中调整即可。

### 流式输出

默认 `STREAM=1`，模型边生成边打印到控制台，肉眼上"反应更快"。如果你要把回答管道给其他工具处理（例如 `node cli.js query "..." > out.txt`），希望一次拿到完整文本，可以关掉：

```text
STREAM=0
```

实现细节：

- OpenAI / LM Studio 走 SSE（`data: {json}\n\n`，最后一行 `data: [DONE]`）。
- Ollama 走 NDJSON（每行一个 JSON 对象，含 `message.content`）。
- `src/providers.js` 的 `chat(messages, { onToken })` 统一封装了这两种协议，对调用方而言只是多了一个回调。

## 环境变量速查

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DOCS_DIR` | `./my-notes` | 业务知识库目录 |
| `VECTOR_STORE` | `./vector-store.ndjson` | 向量库文件路径（NDJSON） |
| `CHUNK_SIZE` | `600` | 每个 chunk 的字符数（语义切块的硬上限） |
| `CHUNK_OVERLAP` | `80` | 相邻 chunk 的重叠字符数（须 < size） |
| `TOP_K` | `4` | 检索时取相似度最高的片段数 |
| `MIN_SCORE` | `0` | 最低相似度阈值，0 关闭过滤 |
| `PER_SOURCE_LIMIT` | `2` | 同一 source 在最终 TopK 中最多出现次数 |
| `STREAM` | `1` | 是否流式输出回答；0 关闭 |
| `EMBED_BATCH_SIZE` | `32` | ingest 每次 embedding 请求的批大小 |
| `INGEST_CONCURRENCY` | `1` | ingest 多个 batch 之间的并发上限 |
| `REQUEST_TIMEOUT_MS` | `60000` | 单次模型请求超时（毫秒） |
| `REQUEST_RETRIES` | `2` | 失败重试次数 |
| `OLLAMA_EMBED_CONCURRENCY` | `4` | Ollama embedding 并发上限 |
| `LLM_TEMPERATURE` | `0.2` | LLM 采样温度 |
| `LLM_PROVIDER` / `EMBEDDING_PROVIDER` | `lmstudio` | 后端选择：`lmstudio` / `ollama` / `openai` / `deepseek`（仅 LLM） |

## 推荐排查顺序

1. 确认 `my-notes/` 里真的写了答案。
2. 重新运行 `npm run ingest`（已支持增量缓存，速度通常很快）。
3. 查询时查看检索结果的 `score` 是否够高、`source` 是否命中正确文件。
4. 调整 `CHUNK_SIZE` / `TOP_K` / `MIN_SCORE`。
5. 最后再改 prompt。

只要记住一句话：RAG 的答案质量，先由检索决定，再由模型表达决定。

## 已知限制

这个项目刻意保持最小，有几个边界要心里有数：

- **全量线性检索**：`src/query.js` 每次都遍历整个向量库算相似度，文档量很大时会变慢，不适合生产规模的知识库。
- **不要手改 `vector-store.ndjson`**：它是 `npm run ingest` 生成的产物，第一行 `_meta` 还携带着 `provider / model / dim` 等元数据，手动编辑容易和原文 / 向量对不上。
- **换 embedding 模型后必须重新 ingest**：不同模型的向量维度和语义空间都不同；脚本会在元数据校验时直接报错，避免继续使用不可靠的检索结果。
- **未实现混合检索 / 重排**：纯向量检索对"专有名词、订单号、ID"这类查询不一定友好。需要时可在 `src/query.js` 里加一路关键词召回再做合并排序。
