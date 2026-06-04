# tiny-rag 性能优化清单

> 本文档基于当前 `src/` 代码和已有 `bench/` 记录整理。它只作为后续迭代的参考与排期依据，不修改代码。
>
> 重要更新：旧版清单中关于 `resolveQueryKeywordStats` / `fromTermCounts` / 每次查询反复构造 keyword `Map` 的描述已经过期。当前代码已经在 retriever 构建期为每条 record 建立 keyword 索引。

---

## 目录

- [一、当前基线](#一当前基线)
- [二、检索热路径](#二检索热路径)
- [三、向量库加载与存储](#三向量库加载与存储)
- [四、Ingest 阶段](#四ingest-阶段)
- [五、关键词分词](#五关键词分词)
- [六、Provider / IO](#六provider--io)
- [七、已落地或不再适用](#七已落地或不再适用)
- [八、推荐优先级](#八推荐优先级)
- [九、基准测试方法](#九基准测试方法)

---

## 一、当前基线

项目已经有独立基准脚本：`bench/bench.ts`。它不在 `test/` 目录内，也不参与日常 `pnpm test`：

```bash
pnpm bench
BENCH_SIZES=1000,10000,50000 pnpm bench
BENCH_LABEL="after-change" pnpm bench
BENCH_BASELINE_SAVE=1 pnpm bench
```

最近一次 `bench/history.jsonl` 中的记录（label: `after-intermediate-cache`，启用 `INTERMEDIATE_DIR=./.tiny-rag-cache`）：

| size | dim | loadMs | retrieverMs | vectorOnlyAvgMs | hybridAvgMs |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 384 | ~10.7ms | ~9.4ms | ~0.62ms | ~1.54ms |
| 10,000 | 384 | ~102.2ms | ~77.1ms | ~3.31ms | ~7.51ms |

这说明当前 10k chunk 的单次检索还没有到“百毫秒级热路径”的程度。后续优化应先用 bench 确认瓶颈在加载、检索、ingest 还是 provider IO。

---

## 二、检索热路径

### 2.1 BM25 仍有多次全表扫描，但不再反复构造 Map ⭐⭐

**位置**：`src/query/retrieval.ts` 的 `scoreLoadedVectorStore`

当前 keyword 路径大致是：

1. 遍历所有 record，计算 `docFreqs` 和 `totalTokenCount`
2. 再遍历所有 record，计算 raw BM25 和 `maxKeywordScore`
3. 最后遍历所有 record，计算 vector score、归一化 keyword score、hybrid score，并维护候选池

这仍然是 `O(records * queryTerms + records * dim)`，但旧文档说的“每条 record 反复 `new Map`”已经不成立。当前 `Map` 在 `createSearchIndex` / `indexKeywordStats` 阶段建立。

**已实现**

- 第一遍后如果所有 `docFreqs` 都为 0，直接关闭 keyword 分支，避免第二遍 BM25。
- 在 `createSearchIndex()` 阶段预计算 `contentDocFreqs`、`contentOrHeadingDocFreqs`、`totalContentTokenCount`、`totalHeadingTokenCount`，查询期不再为 docFreq 全表扫描。

**当前结果**

- `10,000` chunks / `dim=384` 下，`hybridAvgMs` 从旧基线约 `12.74ms` 降到最新约 `7.51ms`。
- 代价是 `retrieverMs` 从旧基线约 `25.0ms` 升到最新约 `77.1ms`，也就是把每次查询的 BM25 统计成本前移到索引构建阶段。

**仍可尝试**

- 针对默认 `keywordHeadingWeight` 缓存每条 record 的 weighted token count；如果查询时传入不同权重，再按现有逻辑计算。
- 评估是否把 raw keyword score 和 vector score 同步写入临时数组，减少最终阶段重复取值成本。

**风险 / 注意**

- BM25 需要先知道 `maxKeywordScore` 才能归一化，因此很难完全合并成单遍。
- 当前 10k hybrid 查询约个位到十几毫秒，任何改动都应先跑 bench，避免“优化”引入更高常数成本。

---

### 2.2 dot / normalize 的 typed array 优化需要谨慎 ⭐

**位置**：`src/utils/vector.ts`、`src/query/query.ts`、`src/query/retrieval.ts`

当前加载后的库向量已经压成一块连续 `Float32Array` 矩阵，record 只保留 `embeddingOffset`。查询向量通过 `normalizeToFloat32` 转成 `Float32Array`，`dotEmbeddingAt` 按 offset 做 4 路循环展开。

**当前结果**

- `10,000` chunks / `dim=384` 下，`vectorOnlyAvgMs` 从旧基线约 `4.82ms` 降到最新约 `3.31ms`。
- 连续内存仍不改变磁盘格式；NDJSON 加载阶段还要解析 embedding JSON 数组。

**风险 / 注意**

- 不建议直接把全局 `normalize` 改成返回 `Float32Array`。ingest 写 NDJSON 时依赖普通数组；`JSON.stringify(Float32Array)` 不会输出期望的 JSON array。
- “V8 会自动 SIMD 提速”不能作为保证，必须用本项目 bench 验证。

---

### 2.3 候选池 splice / shift 不是当前默认瓶颈 ⭐

**位置**：`src/query/retrieval.ts` 的 `insertByAscendingScore`

当前候选池大小为：

```ts
candidatePool = Math.max(topK, topK * perSourceLimit)
```

默认 `topK=4`、`perSourceLimit=2`，候选池只有 8。`splice` / `shift` 的理论复杂度是 `O(N)`，但默认场景常数很小，不应优先改。

**何时值得改**

- `topK * perSourceLimit` 经常大于几十
- 线上查询量较高，bench 显示候选池维护占比明显

**可尝试优化**

- 改成固定容量最小堆，`push` / `pop` 为 `O(log N)`。
- 最终输出时再排序，避免每次插入都维护完整顺序。

---

### 2.4 `minScore` 是语义问题，不只是性能问题 ⭐

**位置**：`src/query/retrieval.ts`

当前逻辑：

```ts
if (resolved.minScore > 0 && score < resolved.minScore) continue;
```

这意味着默认 `minScore=0` 不会过滤负分；传入负数也不会生效。旧文档把它描述成“默认值导致剪枝失效”，这个说法不够准确。

**建议先明确语义**

- 如果 `minScore=0` 应该过滤负分，则条件应改为 `score < resolved.minScore`。
- 如果 `0` 表示“不启用阈值”，则当前逻辑应在文档和类型说明里明确，并考虑把默认值改成 `undefined` 更清晰。

这项可能改变查询结果，不能只按性能优化处理。

---

### 2.5 整库全扫描是架构层瓶颈 ⭐⭐⭐

**位置**：`src/query/retrieval.ts`

当前检索是整库暴力扫描，没有 ANN（近似最近邻）索引。10k 级别尚可接受，50k / 100k 以上会成为主要瓶颈。

**短期方向**

- 把 embedding 存为连续 `Float32Array(N * dim)`，用 offset 访问，减少指针跳转和小对象分配。
- 保持旧 NDJSON 向量库兼容，避免一次性破坏用户数据。

**长期方向**

- 对大于阈值的向量库可选启用 ANN，例如 HNSW。
- ANN 会引入原生依赖、构建复杂度和召回率调参，建议放在 P3，等 50k+ 数据规模确实出现后再做。

---

## 三、向量库加载与存储

### 3.1 避免每次查询重新加载向量库 ⭐⭐⭐

**位置**：`src/query/query.ts`、`src/query/retrieval.ts`、`serve.ts`

`query()` 如果没有传 `retriever`，会走 `searchVectorStore()`，每次查询都创建 retriever 并加载向量库。对于服务或应用内多次查询，应复用 `createRetriever()` 的结果。

当前 `serve.ts` 和 CLI `query` 命令已经这么做。库使用者也应优先：

```ts
const retriever = await createRetriever(embeddingConfig, searchOptions);

await query(question, {
  ...options,
  retriever,
});
```

**收益**

- 多次查询时直接省掉 `loadVectorStore` 和 keyword 索引构建。
- 对 10k chunk，启用中间态缓存后最近 bench 中加载约 `102ms`、retriever 构建约 `77ms`。如果不复用 retriever，这两项通常仍比单次检索本身更值得优化。

---

### 3.2 可选中间态缓存目录：跳过重复 NDJSON 解析 ⭐⭐⭐

**位置**：`src/storage/vector-store.ts`、`.env`

可以通过 `.env` 配置：

```env
INTERMEDIATE_DIR=./.tiny-rag-cache
```

留空或删除该配置时不启用。启用后，主向量库仍然是原来的 `VECTOR_STORE` NDJSON；系统会在中间态目录里额外保存派生文件：

- `*.manifest.json`：记录源向量库路径、大小、mtime、模型和维度
- `*.records.ndjson`：不含 embedding 数组的 record 元数据
- `*.embeddings.f32`：连续 `Float32Array` embedding 矩阵

**收益**

- 后续 `loadVectorStore()` 可以直接读取二进制矩阵，减少 JSON number array 解析和矩阵重建成本。
- `query`、`serve`、`ingest` 和 `pnpm bench` 都已经走同一个配置。
- 如果源 NDJSON 变更，manifest 校验不通过，会自动回退 NDJSON 并重写中间态缓存。

**风险 / 注意**

- 第一次加载旧向量库仍要解析 NDJSON；收益主要体现在第二次及之后。
- `ingest` 重新写向量库时会同步写中间态缓存，因此导入阶段写盘会多一点，但查询冷启动更快。
- 中间态目录只保存派生数据，可以删除；删除后下次会自动重建。

---

### 3.3 NDJSON 行内 embedding 解析慢 ⭐⭐

**位置**：`src/storage/vector-store.ts` 的 `streamVectorStoreRecords`

当前每条 record 都是一行 JSON，embedding 也是 JSON number array。加载时需要逐行 `JSON.parse`，再把 embedding 转为 `Float32Array`。

**可尝试优化**

- 元数据和文本字段继续用 NDJSON，embedding 单独写入 `.bin` 旁路文件。
- 加载时一次性读取 `.bin`，构造连续 `Float32Array`。
- 保留旧格式读取路径，写入新格式时提升 schema version 或增加格式标记。

**收益判断**

- 对大维度 embedding 更明显，例如 dim=1024 / 1536 / 3072。
- 对当前 bench 的 dim=384、10k chunks，启用中间态缓存后加载约 `102ms`；未启用时 NDJSON 数字数组解析仍可能在几百毫秒量级。

---

### 3.4 每条 record 单独分配 Float32Array 已优化 ⭐⭐

**位置**：`src/storage/vector-store.ts` 的 `loadVectorStore`

当前加载后会创建一块连续矩阵：

```ts
embeddings = new Float32Array(records.length * dim)
```

record 中只保留 `embeddingOffset`，检索时按 offset 计算 dot。

**风险 / 注意**

- 这只优化内存布局，不改变磁盘格式。
- `loadMs` 仍然受 NDJSON 数字数组解析影响；如果要继续降冷启动，需要做二进制旁路。

---

## 四、Ingest 阶段

### 4.1 文档读取已改为并发 ⭐⭐

**位置**：`src/ingestion/documents.ts`

当前会先按原有递归排序收集文件路径，再用 `runWithConcurrency` 并发读取文件内容。这样保留 `SourceDocument[]` 输出顺序稳定，同时减少大目录 ingest 的 IO 等待。

**已实现**

- 先递归收集并排序文件路径，保证输出顺序稳定。
- 再用 `runWithConcurrency` 并发读取；当前固定并发为 `16`。

**风险 / 注意**

- 必须保持 `SourceDocument[]` 顺序稳定，否则 chunk id 和向量库输出顺序会变化。
- `filterDocument` 当前拿到的是完整 `content`，所以仍要在读取后执行。

---

### 4.2 embedding 缓存命中检测有轻微重复 ⭐

**位置**：`src/ingestion/ingest.ts`

当前先在 `chunks.map()` 里判断一次 `hasValidEmbedding(cached)`，再遍历 `records` 时判断一次 `hasValidEmbedding(r.embedding)` 来生成 `todoIdx`。

**可尝试优化**

- 构造 `records` 时同步维护 `todoIdx`。

**收益判断**

- 这是微优化。相比 embedding 请求、文件 IO、JSON 写入，收益很小。

---

### 4.3 缓存命中后统一 normalize ⭐

**位置**：`src/ingestion/ingest.ts`

当前新生成向量已经在 batch 内 normalize，最后又会对所有 records 统一 normalize 一次。这是为了兼容旧缓存中可能未归一化的向量。

**可尝试优化**

- 在 `_meta` 中增加 `normalized: true` 或通过 schema version 明确当前向量库已归一化。
- 命中缓存且确认旧库已归一化时跳过二次 normalize。

**风险 / 注意**

- 这是格式语义变更，应保留旧库兼容路径。
- 如果未来支持不同归一化策略，需要把策略也写入 meta。

---

### 4.4 SourceDocument 全量加载到内存 ⭐

**位置**：`src/ingestion/documents.ts`、`src/ingestion/ingest.ts`

当前会先把所有源文档读成 `SourceDocument[]`，再统一切块。普通文档目录没有问题；极大目录会增加内存峰值。

**可尝试优化**

- 将 `loadDocuments` 改成 async generator。
- `buildChunkRecords` 支持流式消费，边读边切块。

**风险 / 注意**

- 当前 ingest 需要先构造全部 chunks 再做缓存匹配和 batch embedding。真正流式化会牵涉更多流程，不应作为早期优化。

---

## 五、关键词分词

### 5.1 中文 bigram 会增加 termCounts 体积 ⭐⭐

**位置**：`src/query/keyword.ts`

当前中文连续字符使用 bigram。它能提升中文短语的 keyword 命中能力，但会增加：

- 向量库文件大小
- 加载时 JSON parse 成本
- retriever 构建 keyword `Map` 的成本
- BM25 查询时的 term 查找成本

**可尝试优化**

- 统计全库高频 bigram，过滤明显无区分度的词。
- 对超长中文段落限制最大 keyword token 数。
- 引入可配置 tokenizer，而不是直接删除 bigram。

**风险 / 注意**

- 这会影响检索质量，不是纯性能优化。
- 需要同时比较性能指标和 keyword fusion 的召回 / 排序效果。

---

## 六、Provider / IO

### 6.1 Ollama embedding 可检测批量接口 ⭐⭐

**位置**：`src/providers/ollama.ts`

当前使用 `/api/embeddings`，一次请求一个 prompt，再通过 `runWithConcurrency` 并发。部分 Ollama 版本提供 `/api/embed`，可一次传入多个 input。

**可尝试优化**

- 启动或首次请求时探测 `/api/embed` 是否支持数组 input。
- 支持时走批量接口；不支持时回退当前 `/api/embeddings` 并发方案。
- `OLLAMA_EMBED_CONCURRENCY` 默认值是否提高，应由本机 CPU/GPU 和模型实测决定，不建议盲目改到 8 或 16。

---

### 6.2 fetch retry 更偏可靠性，不是主要性能点 ⭐

**位置**：`src/providers/http.ts`

当前 4xx 直接返回给调用方处理，5xx / 网络错误走 retry。

**可尝试优化**

- retry 退避加入 jitter，避免并发请求同步重试。
- 4xx 是否在 `fetchWithRetry` 内直接读 body 并抛错，需要权衡：这样会统一错误处理，但也会减少调用方自定义错误信息的空间。

**收益判断**

- 这主要改善稳定性和错误行为，不应列为性能 P0。

---

### 6.3 readLines buffer 拼接影响很小 ⭐

**位置**：`src/providers/http.ts`

当前流式读取时使用：

```ts
buffer += decoder.decode(value, { stream: true });
```

理论上大量长 chunk 会产生重复拷贝；但聊天流式 token 一般行很短，这不是当前主要瓶颈。

**可尝试优化**

- 如果未来处理批量大文本流，再改成片段数组 + join 或更细的行解析器。

---

## 七、已落地或不再适用

以下是旧清单中已经过期的条目：

| 旧编号 | 当前状态 |
|---|---|
| 1.1 “对每条 record 调 3 次 `resolveQueryKeywordStats`” | 已过期。当前代码没有这个函数，keyword `Map` 在 retriever 构建期建立。 |
| 3.4 “查询期反复把 termCounts 转 Map” | 已落地。`createSearchIndex` 会为每条 record 建索引。 |
| 4.2 “resolveQueryKeywordStats 走两遍” | 已过期。当前 `src/query/keyword.ts` 只负责 tokenize 和 build stats。 |
| 6.1 “Set 反复构造” | 已过期。当前没有按 record 构造 query term `Set` 的路径。 |
| “建议新增 bench 基准脚本” | 已落地。当前为 `bench/bench.ts`，通过 `pnpm bench` 运行。 |
| “多次查询场景复用 `createRetriever()`” | 已落地。`serve.ts` 和 CLI `query` 会预创建 retriever；库调用方仍可显式传入。 |
| “查询向量 typed array + dot 循环展开” | 已落地。新增 `normalizeToFloat32`，retriever 支持 `ArrayLike<number>`。 |
| “BM25 空命中短路” | 已落地。`docFreqs.size === 0` 时跳过 raw BM25 阶段。 |
| “文档并发读取” | 已落地。先稳定排序收集路径，再以并发 16 读取内容。 |
| “BM25 docFreq/token totals 预索引” | 已落地。查询期复用索引构建阶段的语料统计。 |
| “加载后连续 Float32Array 矩阵” | 已落地。`LoadedVectorStore` 持有 `embeddings`，record 持有 `embeddingOffset`。 |

---

## 八、推荐优先级

| 优先级 | 改动 | 判断依据 |
|---|---|---|
| P0 | 每次改动前后跑 bench，并把结果写入 `bench/history.jsonl` | 当前已有基线，先防止无效优化。 |
| P1 | 向量库二进制旁路 | 继续解决加载耗时，尤其是大维度 embedding 的 JSON 数字解析成本，但涉及格式兼容。 |
| P2 | 默认 heading weight token count 缓存 | 小到中等收益，适合跟 query bench 一起做。 |
| P2 | Ollama `/api/embed` 批量兼容 | provider 相关，取决于本地 Ollama 版本和模型。 |
| P2 | 中文 bigram 降噪 | 可能减少文件和索引体积，但影响检索质量。 |
| P3 | ANN / HNSW | 50k+ / 100k+ chunk 后再考虑。 |
| P3 | ingest 全流程流式化 | 极大目录才必要，改动面较大。 |

---

## 九、基准测试方法

建议流程：

1. 改动前跑一次：

   ```bash
   BENCH_LABEL="before-change" pnpm bench
   ```

2. 改动后跑同样参数：

   ```bash
   BENCH_LABEL="after-change" pnpm bench
   ```

3. 如果改的是大库性能，增加 size 和 dim：

   ```bash
   BENCH_SIZES=10000,50000 BENCH_DIM=1024 BENCH_QUERY_TIMES=10 pnpm bench
   ```

4. 只在结果稳定且收益明确时保存 baseline：

   ```bash
   BENCH_BASELINE_SAVE=1 pnpm bench
   ```

需要重点观察：

- `loadMs`：向量库加载耗时
- `retrieverMs`：keyword 索引构建耗时
- `vectorOnlyAvgMs`：纯向量检索耗时
- `hybridAvgMs`：向量 + keyword fusion 检索耗时
- `rssBeforeMB` / `rssAfterMB`：内存占用变化

不要只看单次结果。Node/V8、机器负载、文件缓存都会带来波动，至少跑 2 到 3 次再判断趋势。
