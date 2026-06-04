# 第三步：对着代码看流程

这一篇不是让你一次读懂所有代码，而是先知道每个文件负责哪一段。读代码时建议按这个顺序看：

```text
cli.js  ->  src/ingest.js  ->  src/query.js  ->  src/providers.js  ->  src/utils.js
```

`cli.js` 是命令行入口，只负责把 `npm run ingest` / `npm run query` 分发到对应函数。`src/` 目录只放可复用代码，测试或外部脚本可以从 `src/index.js` 导入这些函数。

## src/ingest.js：把资料变成向量库

`src/ingest.js` 负责导入业务知识库。入口配置大致是：

```js
const DOCS_DIR = envString('DOCS_DIR', './my-notes');
const VECTOR_STORE = envString('VECTOR_STORE', './vector-store.ndjson');
const CHUNK_SIZE = envInteger('CHUNK_SIZE', 600, { min: 1 });
const CHUNK_OVERLAP = envInteger('CHUNK_OVERLAP', 80, { min: 0 });
```

默认读取 `my-notes/`。这就是为什么 `docs/` 里的学习文档不会被导入。

主要流程在 `main()` 里：

```text
读取文档 -> 语义切块 -> 命中缓存 -> 增量 embedding -> L2 归一化 -> 写入 NDJSON
```

关键点：

- `loadDocs()`：递归读取 `.md` 和 `.txt` 文件，并按文件名排序，让每次导入的顺序稳定。
- `splitSemantic()`：先按 Markdown 标题分节，再按空行段落聚合；段落仍然太长时才按字符数硬切。
- `loadEmbeddingCache()`：用 chunk 内容的 hash 复用旧 embedding。只要某段文字没变，就不用重新请求模型。
- `normalize()`：把向量做 L2 归一化。查询时直接做点积，就等价于 cosine 相似度。
- `writeNdjson()`：先写临时文件，再 rename 成正式的 `vector-store.ndjson`。每次导入都是重新生成文件，不是在旧文件后面追加。

`vector-store.ndjson` 的第一行是 `_meta`，记录 `version / provider / model / dim / chunkSize / chunkOverlap`。后面每一行才是一条 chunk。

## src/query.js：从向量库里找答案

`src/query.js` 负责回答问题。它的流程是：

```text
读取问题 -> 检查向量库 -> 生成问题 embedding -> 遍历 chunk 算相似度 -> 取 TopK -> 调用大模型回答
```

这里有两个重要的保护：

- 向量库的 `provider / model / dim` 必须和当前 embedding 配置一致；不一致会直接退出，并提示重新 `npm run ingest`。
- 每条 chunk 的 embedding 必须是合法数字数组，而且维度必须和问题向量一致；坏数据会被跳过或报错。

相似度计算在概念上就是：

```text
问题向量 · 文档 chunk 向量 = cosine 相似度
```

脚本会先保留一批候选片段，再用 `pickHitsByDiversity()` 控制同一个文件最多出现几次，避免 TopK 全被一个文件占满。

最后，`buildContext()` 会把命中的资料拼成 prompt。system prompt 要求模型只能基于资料回答；如果资料中没有答案，就回答“我不知道”。

## src/providers.js：和模型服务通信

`src/providers.js` 把不同模型服务包装成两个统一函数：

- `embed(inputs)`：把文本数组转成向量数组。
- `chat(messages, { onToken })`：把 prompt 发给聊天模型，拿到回答。

当前支持：

- LM Studio
- Ollama
- OpenAI 或兼容 API
- DeepSeek（只用于 LLM，embedding 仍要用其它 provider）

这里还做了几件防错工作：

- 所有 HTTP 请求都有超时和重试。
- OpenAI / LM Studio 的 embedding 可以批量请求。
- Ollama 的 embedding 用有限并发逐条请求。
- provider 返回的 embedding 会检查数量、维度和数值是否合法。

## src/utils.js：小工具集中放这里

`src/utils.js` 放的是容易单独测试的小工具：

- `envString()` / `envInteger()` / `envNumber()` / `envBoolean()`：读取 `.env`，并在配置写错时尽早报错。
- `splitSemantic()` / `splitByLength()`：把长文档切成 chunk。
- `normalize()` / `dot()`：处理向量和相似度。
- `insertSorted()` / `pickHitsByDiversity()`：维护检索候选结果。
- `hasValidEmbedding()`：检查 embedding 是否是合法的数字数组。

如果你是第一次读这个项目，不需要先读完 `utils.js`。遇到某个函数时，再跳进去看它做什么即可。

## 换模型后为什么要重新 ingest

embedding 模型不同，生成的向量空间也不同。即使两段文本一样，用不同 embedding 模型得到的向量也不能直接比较。

所以只要你改了：

```text
EMBEDDING_PROVIDER
LMSTUDIO_EMBEDDING_MODEL
OLLAMA_EMBEDDING_MODEL
OPENAI_EMBEDDING_MODEL
```

就重新运行：

```bash
npm run ingest
```

如果忘了重跑，`src/query.js` 会在读取 `vector-store.ndjson` 的 `_meta` 时发现不一致，并提示你重新导入。
