---
title: 后续扩展路线
description: 按架构层次规划 tiny-rag 的扩展路线，判断 reranker、向量数据库、文件格式和权限能力应该落在哪里。
---

tiny-rag 刻意把功能控制在「能读懂」的范围内。这一章说明常见扩展应该落在哪一层，并列出明确的 TODO 清单。

扩展 RAG 项目时，最怕的是为了一个新能力把所有层都搅在一起：PDF 解析影响 query，权限过滤塞进 Prompt，向量数据库反过来污染入口层。tiny-rag 的价值在于边界清楚，所以扩展时也应该先问“这个能力属于哪一层”。

:::note[本章目标]
这一章不是功能承诺，而是一张“**扩展落点图**”：当你想加 PDF 解析、reranker、向量数据库、多轮对话或权限时，先判断它属于哪一层、是否改变主数据流，再动手。守住分层，扩展才不会让代码越改越乱。
:::

## 扩展原则

始终守住这条边界：

```text
入口层（cli.ts / serve.ts）读 env、打印、监听 HTTP
src/ 层接收显式参数、返回结构化结果
```

新增功能时先问两个问题：

1. 这是核心库能力，还是入口职责？
2. 它是否依赖进程环境、终端、HTTP 请求或外部配置？

依赖运行环境的放入口层；纯业务能力放进 `src/` 并补测试。

还有一个判断标准：新能力是否改变主数据流。如果它只是把新文件转成 `SourceDocument`，就不该影响 retrieval；如果它只是换存储实现，就不该影响 Prompt；如果它只是服务端鉴权，就不该进入核心 query 逻辑。

## 扩展文件格式（PDF / HTML / DOCX）

落在 ingestion 层。加一个解析器，输出仍是 `SourceDocument`（`{ source, content }`），不改 `buildChunkRecords()` 和后续流程。只要能把新格式转成纯文本和 source，切块、embedding、检索都能复用。

难点通常不在“读出文本”，而在文本质量：PDF 换行、页眉页脚、表格顺序、HTML 导航噪声，都会影响切块。解析器最好同时负责清洗，并保留稳定 source，让命中结果仍然能回查。

## 接入向量数据库

替换 storage / retrieval 的一部分，而不是改 query 编排。从 `VectorStoreRetriever` 接口入手：

```ts
{
  meta: StoreMeta;
  recordCount: number;
  search(queryEmbedding, queryText, options): SearchResult;
}
```

外部数据库只要也能返回 `SearchHit[]`，`query()` 后面的 `selectDiverseHits()`、`buildContext()`、`chat()` 都不用变。

向量数据库的价值主要在规模、过滤和检索性能。接入时要避免把数据库 SDK 泄漏到 query 编排里，否则未来再换数据库会变成全链路修改。

## 加 reranker

放在检索候选之后、最终 hits 之前：

```text
candidates = retriever.search()
reranked   = rerank(question, candidates)
hits       = selectDiverseHits(reranked)
```

reranker 通常更贵，不要只取 `TOP_K` 再 rerank——应该先取更大的候选池（如 `TOP_K * 5`）再重排。

reranker 适合解决“候选里有正确片段，但排序不够好”的问题。它不能修复文档没导入、chunk 切坏、权限过滤错误这类前置问题。加 reranker 前，先确认候选池里确实有答案。

## 加多轮对话

不要塞进 storage 层。扩展 `QueryOptions`：增加历史消息、自定义 `buildMessages()`、控制历史摘要与当前检索上下文的拼接顺序。默认 Prompt 是单轮问答，多轮场景要特别小心：历史消息不能覆盖「只能基于参考内容回答」的规则。

多轮对话的核心风险是历史和当前证据的优先级。用户上一轮说过的话可以帮助理解问题，但不能替代当前检索证据，更不能覆盖 system prompt 的安全约束。

## 加权限和安全

当前只有基础 HTTP token。用于团队或公网服务，至少要补：用户身份、查询审计、知识库权限过滤、请求速率限制、模型调用成本限制、日志脱敏。

:::caution[权限是架构能力，不是 Prompt 技巧]
不要指望在 Prompt 里写一句“不要回答无权内容”就算做了隔离——模型不是可靠的访问控制层。**无权的 chunk 根本不应该进入候选列表**，更不该出现在上下文里。所以权限过滤要尽量做在 retrieval **之前**：先按用户身份筛掉无权 chunk，再做检索和排序。
:::

权限是架构能力，不是 Prompt 技巧。不要指望模型“不要回答无权内容”就算完成隔离；无权 chunk 不应该进入候选列表，更不应该出现在上下文里。

## TODO 清单

按价值和实现成本大致排序：

| TODO | 落点 | 说明 |
| --- | --- | --- |
| PDF / HTML 解析 | ingestion | 输出 `SourceDocument` 即可接入现有流程 |
| reranker | query（检索后） | 先扩大候选池再重排，注意成本 |
| 多轮对话 | query（`QueryOptions`） | 历史消息不能覆盖安全约束 |
| 接入向量数据库 | storage / retrieval | 实现 `VectorStoreRetriever` 接口 |
| 知识库权限过滤 | retrieval 前 | 团队 / 公网服务的前置条件 |
| 请求速率限制 | serve | 现有并发限制之外的补充 |
| 查询审计与日志脱敏 | serve | 合规与排障 |
| 更强中文分词 | keyword | 当前是 bigram，可换分词库 |

这张表不是承诺清单，而是扩展落点图。优先做哪一项，取决于当前瓶颈：资料格式不够就先扩 ingestion，检索排序不稳就看 reranker，数据量上来再看向量数据库，团队使用再补权限和审计。

## 发布前检查

```bash
pnpm typecheck
pnpm test
pnpm build
```

文档站在 `docs/` 下跑 `pnpm build`。GitHub Actions 会执行文档构建，并在非 PR 事件中上传 GitHub Pages artifact。

扩展前后都应该保留这套检查。RAG 项目的很多问题不会在类型层暴露，所以除了构建和测试，还要准备几条固定查询作为回归样例，观察命中 source 和最终回答是否符合预期。

## 本章小结

- 扩展前先问两件事：**它属于哪一层**？**它是否改变主数据流**？依赖运行环境的进入口层，纯能力进 `src/`。
- 落点速记：文件格式 → ingestion；reranker / 多轮 → query；向量数据库 → storage/retrieval；权限 → retrieval 之前；限流/审计 → serve。
- 权限是架构能力不是 Prompt 技巧；reranker 解决排序不解决召回；向量数据库别把 SDK 泄漏进 query 编排。
- 发布前固定跑 `typecheck / test / build`，并用几条回归查询验证召回和回答。

:::tip[读完整套文档之后]
你已经走完“理解边界 → 从零构建 → 工程化 → 扩展”的完整路径。回到 [RAG 项目概览](/tiny-rag/overview/) 末尾那组学习目标问题自测一下：如果都能用源码里的函数和数据结构解释清楚，说明你真正理解了一个 RAG 系统如何工作，而不只是会调框架。
:::
