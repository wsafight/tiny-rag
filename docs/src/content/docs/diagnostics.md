---
title: 诊断与解析方法
description: 把 tiny-rag 的导入结果、检索候选、命中片段、Prompt 上下文和耗时指标串成一套可复现的 RAG 排查方法。
---

RAG 出问题时，最容易听到一句话：模型回答不对。

> **诊断阶段**：在动手调参前，先学会用中间结果定位问题落在哪一层。

但“回答不对”只是最终现象，不是根因。真正要解析的是整条链路：资料有没有读进来，chunk 是否保住答案条件，向量库是否和当前 embedding 模型匹配，候选片段是否包含答案，最终进入 Prompt 的 hits 是否足够干净，聊天模型是否遵守了证据边界。

本章把 tiny-rag 的运行结果拆成一套诊断方法。目标不是多背几个参数，而是学会用 `candidates`、`hits`、`score`、`meta`、`skippedReason` 和耗时字段判断问题落在哪一层。

:::note[本章目标]
读完这一章，你应该能把一次失败问答拆成三类问题：**导入问题**、**召回问题**、**生成问题**。并且能说出下一步该看哪个字段、调哪个参数、回到哪段源码，而不是一上来改 Prompt 或换模型。
:::

## 这一章要解决什么问题

RAG 的调试难点在于：每一步都可能“看起来能跑”。

- 文档读到了，但 `source` 不稳定，缓存和回查会乱。
- 向量库存在，但 `_meta` 来自旧 embedding 模型，分数没有意义。
- 检索返回了 TopK，但这些只是“最像的片段”，不一定有答案。
- Prompt 拼好了，但上下文里混入无关片段，模型会被干扰。
- 聊天模型给出流畅回答，但引用的证据并不支持结论。

所以排查 RAG 不能只看最终答案。你需要把系统当成一条带观测点的流水线：

```text
documents
  -> SourceDocument[]
  -> ChunkRecord[]
  -> vector-store.ndjson + _meta
  -> candidates
  -> hits
  -> context
  -> answer
```

每个箭头都对应一个可以检查的中间结果。只要中间结果可解释，最终答案就不再是黑盒。

## 先解释几个信号

### candidates

`candidates` 是检索器排序后的候选池，来自 `retriever.search()`。

它还没有经过最终的同源限制。也就是说，某个长文档如果有很多高分 chunk，可能在 `candidates` 里占很多条。这个字段适合判断“正确片段有没有被检索器排进候选池”。

### hits

`hits` 是最终进入 Prompt 的片段，来自 `selectDiverseHits()`。

它会受到 `TOP_K` 和 `PER_SOURCE_LIMIT` 影响。正确片段如果在 `candidates` 里、但不在 `hits` 里，问题通常不是 embedding，而是 TopK、同源限制或候选池排序。

### score / vectorScore / keywordScore

`score` 是最终融合分数。tiny-rag 同时保留：

- `vectorScore`：问题向量和 chunk 向量的点积分数。
- `keywordScore`：BM25 归一化后的关键词分数。
- `score`：按 `KEYWORD_WEIGHT` 融合后的最终分数。

如果 `vectorScore` 高但 `keywordScore` 低，说明语义接近但字面词不强；如果 `keywordScore` 高但 `vectorScore` 低，说明精确词命中了，但上下文语义可能不够接近。

### context

`context` 是 `buildContext(hits)` 之后真正发给聊天模型的参考内容。

不要只看 `hits` 列表。最终 Prompt 里标题、source、编号和正文是怎样拼起来的，也会影响模型引用和回答边界。调试时可以打开 `includeContext` 直接检查。

### meta

`meta` 是向量库契约，记录 schema、provider、model、dim、chunk 参数和导入指纹。

只要 embedding provider/model、向量维度或 chunk 参数不匹配，旧向量库就不应该被拿来查。这个校验是为了避免“有分数但排序全错”的隐性问题。

### skippedReason

`ingest()` 可能返回：

- `no-docs`：没有读到文档。
- `no-chunks`：文档读到了，但没有生成 chunk。
- `unchanged`：导入指纹一致，本次跳过重建。

这三个结果都不是失败，但它们会解释为什么没有发起 embedding 或没有写新向量库。

## 最小心智模型

把查询阶段想成下面这条回路：

```text
question
  |
  v
embed(question)
  |
  v
retriever.search()  -> candidates
  |
  v
selectDiverseHits() -> hits
  |
  v
buildContext()      -> context
  |
  v
chat(messages)      -> answer
```

这条图里最关键的，不是“最后调用了模型”，而是：

> 模型只能回答 `context` 里有的证据；`context` 只来自 `hits`；`hits` 又只来自检索候选。

所以答案错时，先沿着这条链往回看。不要跳过 `candidates` 和 `hits` 直接调 Prompt。

## 按现象定位

| 现象 | 先看什么 | 常见根因 | 优先动作 |
| --- | --- | --- | --- |
| 答案完全无关 | `hits.source` / `hits.heading` | 召回错了 | 看切块、embedding 模型、`KEYWORD_WEIGHT`、`TOP_K` |
| 正确片段在 `candidates`，没进 `hits` | `candidates` 与 `hits` 差异 | 同源限制或 TopK 截断 | 调大 `TOP_K`，检查 `PER_SOURCE_LIMIT` |
| source 对，但片段缺关键条件 | chunk 内容 | chunk 太小或标题上下文丢失 | 调大 `CHUNK_SIZE` / `CHUNK_OVERLAP`，改善文档结构 |
| 片段混入多个主题 | chunk 内容 | chunk 太大或原文段落太长 | 调小 `CHUNK_SIZE`，清理原文标题层级 |
| 专有名词、型号、错误码召回不到 | `keywordScore` | 字面信号太弱 | 提高 `KEYWORD_WEIGHT` 或 `KEYWORD_HEADING_WEIGHT` |
| 自然语言问题被关键词噪声干扰 | `vectorScore` / `keywordScore` | 关键词权重过高 | 降低 `KEYWORD_WEIGHT` |
| 库里没答案但模型硬答 | `score`、`MIN_SCORE`、Prompt | 弱相关片段进入上下文 | 设置 `MIN_SCORE`，确认 unknown prompt |
| 修改文档后结果没变 | `ingest()` 返回值 / `/reload` | 未重新导入或服务未 reload | 先 `pnpm ingest`，HTTP 服务再 `POST /reload` |
| 换 embedding 后结果怪 | `meta.provider/model/dim` | 旧向量库被误用 | 重新 `pnpm ingest`，不要复用旧库 |
| HTTP 第一次慢、后面快 | `searchElapsedMs` | 加载/索引成本 | 配 `INTERMEDIATE_DIR`，复用常驻 retriever |

这个表的用法很简单：先按现象找层，再只改这一层相关的参数。一次改多个参数，很难判断哪个动作真正产生了影响。

## 查询解析流程

真实源码里，查询入口是 `src/query/query.ts` 的 `query(question, options)`。

它的关键步骤是：

1. trim 问题，空问题直接失败。
2. 调 `embed([question])` 得到问题向量。
3. L2 归一化问题向量。
4. 如果调用方传了 `retriever`，直接复用；否则调用 `searchVectorStore()` 加载向量库并检索。
5. 得到 `candidates`。
6. 用 `selectDiverseHits()` 生成最终 `hits`。
7. 如果 `hits.length === 0`，不调聊天模型，直接返回 unknown answer。
8. 用 `buildContext()` 和 `buildMessages()` 组装 Prompt。
9. 调 `chat()` 生成回答，并返回各阶段耗时。

这也是为什么 HTTP 服务应该在启动时创建 retriever：同一个向量库没必要每次请求都重新加载。CLI 则保留短进程行为，每次重新读取配置和向量库，方便调试。

## candidates 和 hits 的区别

`candidates` 与 `hits` 是 tiny-rag 很重要的解析分层。

```text
全部记录
  -> 分数排序
  -> candidatePool
  -> candidates
  -> selectDiverseHits()
  -> hits
```

`candidates` 解决“检索器认为哪些片段相关”。`hits` 解决“最终给模型哪些证据”。这两个问题不能混在一起。

例如，一个文档里连续 5 个 chunk 都和问题相关。它们可能全部出现在 `candidates` 前排，但 `PER_SOURCE_LIMIT=2` 会让最终 `hits` 只保留其中两条，给其他 source 留位置。这不是检索失败，而是上下文多样性的取舍。

如果正确答案在 `candidates` 里：

- 但不在 `hits`：先看 `TOP_K`、`PER_SOURCE_LIMIT` 和多样性取舍。
- 且排名很靠后：看 `KEYWORD_WEIGHT`、chunk 质量和标题权重。

如果正确答案完全不在 `candidates` 里：

- 回到导入、切块、embedding 模型和关键词分词。

## 分数怎么读

不要把 `score` 当成绝对概率。

分数只在同一向量库、同一 embedding 模型、同一组检索参数下有比较意义。换模型、换 chunk 参数、换 `KEYWORD_WEIGHT` 后，分数分布都会变。

更稳的读法是看相对关系：

- 第一名和第二名差距很大：检索比较确定。
- 前几名分数接近：问题可能跨主题，或者知识库里有多段相似内容。
- `keywordScore` 只有少数片段很高：查询里有明确字面词。
- 所有 `keywordScore` 都是 0：问题没有命中关键词索引，排序主要靠向量。
- 所有分数都很低：可能知识库没有答案，考虑 `MIN_SCORE`。

设置 `MIN_SCORE` 前，先收集几组“有答案问题”和“无答案问题”的分数。不要照搬别人模型上的阈值。

## 导入解析流程

导入入口是 `src/ingestion/ingest.ts` 的 `ingest(options)`。

它的可观察结果包括：

| 字段 | 含义 | 怎么解读 |
| --- | --- | --- |
| `docsCount` | 读到的文档数 | 为 0 时先查目录、扩展名、过滤规则 |
| `chunksCount` | 生成的 chunk 数 | 为 0 时看文档内容和切块函数 |
| `cachedCount` | 复用旧 embedding 的 chunk 数 | 越高表示增量缓存命中越多 |
| `embeddedCount` | 本次新算 embedding 的 chunk 数 | 成本主要由它决定 |
| `skippedReason` | 跳过原因 | `unchanged` 表示指纹一致，没必要重建 |
| `meta` | 新向量库契约 | 查询阶段会用它判断能否比较 |

导入的两个缓存也要分清：

- **导入指纹**：判断整次导入是否完全没变，没变就跳过。
- **hash 增量缓存**：需要重建时，判断哪些 chunk 的 embedding 可以复用。

这两个机制解决的问题不同。前者避免无意义构建，后者降低局部修改后的 embedding 成本。

## 常见错判

### 1. 以为 TopK 就是答案

TopK 是“当前排序下最像的 K 个片段”，不是“知识库里一定有答案”。无答案问题也会返回最不差的片段，所以还需要 `MIN_SCORE` 和 unknown answer。

### 2. 召回错了却先改 Prompt

Prompt 只能约束模型如何使用 `context`。如果正确证据没有进入 `hits`，模型无法凭 Prompt 看到它。

### 3. 只看最终 hits，不看 candidates

正确片段可能已经进入候选池，但被同源限制或 TopK 挡在最终上下文之外。调试排序时必须同时看 `candidates` 和 `hits`。

### 4. 把 `source` 当展示字段

`source` 还会影响 chunk id、缓存、回查和用户理解。绝对路径、路径分隔符不统一、排序不稳定，都会让导入结果变得难以复现。

### 5. 忽略 embedding 空间

不同 embedding 模型不能混用。即使两个模型都是 768 维，也不代表向量可比。`_meta` 校验就是为了把这个错误拦在查询前。

## 最小排查清单

遇到一次失败查询时，先把同一个问题的中间结果记下来，不要直接凭最终回答调参数：

```text
question:
expected source:
top candidates:
final hits:
score / vectorScore / keywordScore:
context:
answer:
first broken step:
```

`first broken step` 用来标记证据第一次断在哪里：文档没进库、chunk 切坏、正确片段没进 `candidates`、进了 candidates 但没进 `hits`、context 正确但模型没按证据答。这个小表比“感觉变好了”可靠得多。

## RAG 评测的最小维度

诊断看的是一次失败查询，评测看的是一组固定问题的整体表现。固定问题集、期望 source、答案边界、无答案拒答和结果记录，放到 [RAG 回归评测](/tiny-rag/evaluation/)。

## 它如何接进整套文档

- 如果你发现导入阶段有问题，回到 [B03 文档读取](/tiny-rag/build-03-documents/)、[B04 语义切块](/tiny-rag/build-04-chunking/) 和 [B06 向量库读取与 ingest](/tiny-rag/build-06-ingest/)。
- 如果你发现召回阶段有问题，回到 [B07 纯向量检索](/tiny-rag/build-07-retrieval/)、[B08 BM25](/tiny-rag/build-08-keyword-bm25/) 和 [B09 混合检索](/tiny-rag/build-09-hybrid/)。
- 如果你发现生成阶段有问题，回到 [B10 Prompt 与端到端问答](/tiny-rag/build-10-prompt-query/)。
- 如果你已经定位到参数层，查 [配置与检索调参](/tiny-rag/config-tuning/)。
- 如果你想理解为什么 tiny-rag 比 mini-rag 多这些字段和缓存，看 [工程优化如何工作](/tiny-rag/optimizations/)。

## 教学边界

这一章只讲 tiny-rag 已经暴露的观测点和最小诊断流程。它刻意不展开：

- 自动化评测集和指标统计。
- reranker 的评估方法。
- 大规模向量数据库的召回分析。
- 多租户权限下的审计报表。

这些都可以继续扩展，但它们不应该替代最基本的链路解析。先把一次查询从 `question` 追到 `answer`，能解释每个中间结果，再谈更复杂的评估系统。

## 一句话记住

RAG 诊断的核心不是问“模型为什么答错”，而是沿着 `documents -> chunks -> candidates -> hits -> context -> answer` 找到第一处证据断裂的位置。
