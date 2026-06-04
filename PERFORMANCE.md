# tiny-rag 性能优化清单

> 本文档基于对 [`src/`](./src) 目录的静态分析整理，按 **预期收益 / 影响范围** 从高到低梳理可执行的性能改造点。
> 文档不修改任何代码，仅作为后续迭代的参考与排期依据。

---

## 目录

- [一、检索热路径（最高收益）](#一检索热路径最高收益)
- [二、向量库加载（启动开销）](#二向量库加载启动开销)
- [三、Ingest 阶段（一次性，但可优化）](#三ingest-阶段一次性但可优化)
- [四、关键词分词（中等收益）](#四关键词分词中等收益)
- [五、Provider / IO（次要）](#五provider--io次要)
- [六、其他细节](#六其他细节)
- [七、优先级与排期建议](#七优先级与排期建议)

---

## 一、检索热路径（最高收益）

### 1.1 BM25 计算重复了 3 遍 ⭐⭐⭐

**位置**：`src/query/retrieval.ts` 中的 `scoreLoadedVectorStore`

对每条 record 都调用了 **3 次** `resolveQueryKeywordStats`：

1. 第 142~154 行：算 `docFreqs` / `totalTokenCount`
2. 第 158~175 行：算 `maxKeywordScore`
3. 第 178~195 行：最终打分

每次都会重新构造 `Map` 并遍历 `termCounts`，存在大量重复劳动与 GC 压力。

**优化方向**

- 第一遍同时收集 `(termCounts, tokenCount)` 缓存到数组，后续两遍直接复用
- 或在 retriever 构建期预先对每条 record 计算并缓存好 term Map（参见 3.3）

**预期收益**：1 万 chunks 量级的查询可省 **40%~60%** 关键词阶段耗时（数十~上百毫秒）。

---

### 1.2 dot 计算未使用 Float32Array ⭐⭐

**位置**：`src/utils/vector.ts` 的 `dot` / `normalize`

向量库已用 `Float32Array` 存储（见 `src/storage/vector-store.ts:243-247`），但：

- `normalize` 仍返回 `number[]`
- query 向量在 `src/query/query.ts` 中也是普通数组

**优化方向**

- `normalize` 直接产出 `Float32Array`
- `dot` 内部循环 4 路展开，对 typed array 更友好（V8 可触发更优 SIMD 路径）

**预期收益**：向量打分阶段 **20%~30%** 提速。

---

### 1.3 minScore 默认值导致剪枝失效

**位置**：`src/query/retrieval.ts:196`

```ts
if (resolved.minScore > 0 && score < resolved.minScore) continue;
```

`DEFAULT_MIN_SCORE = 0` 时该剪枝永远不生效。配合堆 + topK 维持的"当前最低阈值"可做更激进剪枝。

**优化方向**

- 用候选池堆顶分数作为动态阈值，新元素低于阈值直接 skip
- 文档说明：`minScore < 0` 也可能有意义（hybrid score 可能为负），逻辑应更精确

---

### 1.4 insertByAscendingScore 用 splice ⭐

**位置**：`src/query/retrieval.ts:84-93`

`Array.prototype.splice` 是 O(N)，候选池大小 = `topK × perSourceLimit`，每条 record 都可能触发插入。

**优化方向**

- 改为最小堆（binary heap），`push` / `pop` 都是 O(log N)
- 候选池大于 8 时收益开始明显

---

### 1.5 整库全扫描 — 架构层 ⭐⭐⭐

**位置**：`src/query/retrieval.ts` 整体

`scoreLoadedVectorStore` 是 O(N) 暴力检索，没有 ANN（近似最近邻）索引。

**优化方向**

- **短期**：embeddings 全量改用一块连续 `Float32Array(N*dim)`，用 offset 访问，减少指针跳转和 GC 压力
- **长期**：可选集成 `hnswlib-node` 等库，对超过 5 万 chunk 的库自动切换

**预期收益**：连续内存可让单次扫描提速 **1.5~2x**；ANN 在 10 万级以上 chunk 时是数量级差异。

---

## 二、向量库加载（启动开销）

### 2.1 NDJSON 行内 JSON.parse 慢 ⭐⭐

**位置**：`src/storage/vector-store.ts` 中的 `streamVectorStoreRecords`

每行一次 `JSON.parse`，1 万行 × dim=1024 大概几百毫秒到秒级。

**优化方向**

- embedding 单独存为二进制旁路文件（`.bin`），元数据仍用 NDJSON。加载时 `fs.read` 一次性读入 Float32Array
- 或保留 NDJSON，但 embedding 字段改成 base64 编码的 Float32 字节

**预期收益**：启动加载省 **50%~70%** 时间，内存碎片大幅下降。

---

### 2.2 ingest 流程读了两遍同一文件

**位置**：`src/storage/vector-store.ts` 中的 `readEmbeddingCache` 与 `streamVectorStoreRecords`

ingest 流程会顺序读两遍同一文件（先 `readEmbeddingCache` 取缓存，再写新的）。

**优化方向**：合并为一次扫描，内存中维护 `Map<hash, embedding>`。

---

### 2.3 records 数组多次 push 与小堆分配 ⭐

**位置**：`src/storage/vector-store.ts:243-247`

```ts
records.push({
  ...record,
  embedding: Float32Array.from(record.embedding),
});
```

每条 record 都 `Float32Array.from` 单独分配。1 万条 = 1 万个小堆对象。

**优化方向**

- 预先按 chunk 数量一次性分配大 `Float32Array(N*dim)`，每条只复制到对应 offset
- record 中只保留 offset / index，访问时切片

---

## 三、Ingest 阶段（一次性，但可优化）

### 3.1 文档加载串行 ⭐⭐

**位置**：`src/ingestion/documents.ts:34-43`

```ts
for (const entry of entries) {
  ...
  const content = await fs.readFile(fullPath, 'utf-8');
}
```

串行 `await fs.readFile`，目录大时 IO 等待严重。

**优化方向**：用 `runWithConcurrency` 并发读取（IO 密集型设 16~32）。

---

### 3.2 embedding 缓存命中检测重复

**位置**：`src/ingestion/ingest.ts:205-212`

`hasValidEmbedding(cached)` 已在 map 时算过一次，第 211 行又对 `r.embedding` 调一次。

**优化方向**：构造 records 时就同步推 `todoIdx`，免去再遍历一次。

---

### 3.3 缓存命中后兜底归一化全跑

**位置**：`src/ingestion/ingest.ts:246-248`

对所有 record（包括缓存命中的旧向量）都再做一次 `normalize`。

**优化方向**：在 `_meta` 中加 `normalized: true` 标志，命中缓存且 meta 标记已归一化时跳过。

---

### 3.4 关键词 termCounts 在查询期被反复构造

**位置**：`src/query/keyword.ts` 中的 `fromTermCounts`、`resolveQueryKeywordStats`

ingest 阶段已经把 `keywordContentTerms` / `keywordHeadingTerms` 存为 `TermCounts` 数组（已排序），但每次查询时都会通过 `new Map(...)` 重建。

**优化方向**

- 在 `createLoadedRetriever`（`src/query/retrieval.ts:220`）一次性把每条 record 的 `Map<term, count>` 预计算并缓存
- 查询期直接复用，`O(records × terms)` → `O(records × queryTerms)`

**预期收益**：与 1.1 合并后，查询期不再做 Map 构造，省大量 GC。

---

## 四、关键词分词（中等收益）

### 4.1 中文 bi-gram 膨胀 termCounts ⭐

**位置**：`src/query/keyword.ts:13-21`

对每个汉字串生成 `length-1` 个 bi-gram，会大幅膨胀 termCounts 体积，进而增加：

- 向量库文件大小
- 加载时 JSON.parse 时间
- 查询期 Map 构造与 BM25 遍历开销

**优化方向**

- 加停用词 / 高频 bigram 过滤（如"的的"、"了的"）
- bi-gram 限制最大长度，超长字符串采样 unigram

---

### 4.2 resolveQueryKeywordStats 走两遍

**位置**：`src/query/keyword.ts:102-131`

filter content terms 一遍 + heading terms 一遍，每次重建 Map。配合 1.1 的合并优化收益更大。

---

## 五、Provider / IO（次要）

### 5.1 Ollama embedding 单条调用

**位置**：`src/providers/ollama.ts:24-48`

`/api/embeddings` 一次只能传一条 prompt，所以才用 `runWithConcurrency` 并发。

**优化方向**

- 检测到新版 Ollama（>= 0.2.x）支持 `/api/embed` 批量接口，一次请求多条，减少 RTT
- 默认并发 4（`src/providers/runtime.ts:24`）对本机 GPU 偏保守，可调到 8~16

---

### 5.2 fetchWithRetry 4xx 直接返回

**位置**：`src/providers/http.ts:25`

```ts
if (response.status >= 400 && response.status < 500) return response;
```

4xx 返回给上层，调用方再读 text 报错 — 多一次 await。

**优化方向**

- 直接抛错短路
- 退避 `500 * 2^attempt` 没有 jitter，并发场景容易雪崩，加入 ±20% 随机抖动

---

### 5.3 readLines 缓冲拼接

**位置**：`src/providers/http.ts:43-71`

```ts
buffer += decoder.decode(value, { stream: true });
```

在大量 chunk 下是 O(N²) 拷贝。流式 token 一般行很短，影响小；批量返回大文本场景可改为数组 + join。

---

## 六、其他细节

### 6.1 Set 反复构造

**位置**：`src/query/keyword.ts:107`

```ts
const queryTermSet = new Set(queryTerms);
```

在每条 record 调用 `resolveQueryKeywordStats` 时都会构造一次。

**优化方向**：在 `scoreLoadedVectorStore` 入口构造一次 Set 传入。

---

### 6.2 selectDiverseHits 使用 reverse()

**位置**：`src/query/retrieval.ts:217`

候选池升序存储，最后 `pool.reverse()` 是 O(N)。

**优化方向**：改为倒序遍历，省一次分配。影响很小。

---

### 6.3 SourceDocument 全量加载到内存

**位置**：`src/ingestion/documents.ts`

大文档目录会一次性把所有 `content` 读入 `SourceDocument[]`，内存占用 = 全部源文本大小。

**优化方向**：改成 async generator 流式产出，`buildChunkRecords` 同步流式消费。

---

## 七、优先级与排期建议

| 优先级 | 编号 | 改动 | 预期收益 |
|---|---|---|---|
| **P0** | 1.1 + 6.1 | BM25 单遍化 + Set 复用 | 1 万 chunks 单次查询省 ~40~60% 关键词阶段耗时 |
| **P0** | 3.4 | 在 retriever 构建期预计算 termCounts Map | 查询期不再做 Map 构造，省 GC |
| **P1** | 2.1 + 2.3 | embedding 二进制旁路 + 连续 Float32Array | 启动加载省 ~50% 时间，内存碎片大幅下降 |
| **P1** | 1.2 + 1.4 | Float32Array + 循环展开 + 最小堆 | 向量打分 ~20~30% 提速 |
| **P1** | 3.1 | 文档并发读取 | ingest 阶段大目录加速明显 |
| **P2** | 5.1 | Ollama 批量接口 + 调高默认并发 | 节省 RTT |
| **P2** | 4.1 | 中文分词降噪 | 减小存储与 Map 体积 |
| **P3** | 1.5 | 大库切 ANN（hnswlib） | 5 万+ chunk 才有意义 |
| **P3** | 6.3 | SourceDocument 流式化 | 极大目录场景才必要 |

### 推荐执行顺序

1. **第一波（投入产出比最高）**：P0 两条 — 改动局限在 `src/query/retrieval.ts` 与 `src/query/keyword.ts`，无外部依赖、无文件格式破坏，单次 query 在万级 chunks 下基本能从百毫秒降到几十毫秒。
2. **第二波（启动 + 内存）**：P1 中的 2.1 + 2.3，需要轻微调整向量库格式（带向后兼容回退到 NDJSON 即可），ingest 阶段单独跑一次就能完成迁移。
3. **第三波（并发 / IO）**：P1 中的 3.1，简单替换为 `runWithConcurrency`。
4. **按需**：P2/P3 视实际数据规模决定，不必现在就做。

---

## 附：基准测试建议

在动手前请先建立基准，避免"看似优化、实则劣化"。建议在 `test/` 下加一个 `bench.test.ts`：

- 用 1k / 1w / 5w 三档 chunk 数据
- 测量：
  - 向量库加载耗时（冷启动）
  - 单次 query 耗时（关键词关 / 开两种）
  - 内存占用峰值（`process.memoryUsage().rss`）
- 每次改动前后跑一次，回归确认。
