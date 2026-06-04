---
title: 扩展与 TODO
description: 接入 reranker、向量数据库、新文件格式、多轮对话、权限安全的扩展位置，以及未来 TODO 清单。
---

tiny-rag 刻意把功能控制在「能读懂」的范围内。这一章说明常见扩展应该落在哪一层，并列出明确的 TODO 清单。

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

## 扩展文件格式（PDF / HTML / DOCX）

落在 ingestion 层。加一个解析器，输出仍是 `SourceDocument`（`{ source, content }`），不改 `buildChunkRecords()` 和后续流程。只要能把新格式转成纯文本和 source，切块、embedding、检索都能复用。

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

## 加 reranker

放在检索候选之后、最终 hits 之前：

```text
candidates = retriever.search()
reranked   = rerank(question, candidates)
hits       = selectDiverseHits(reranked)
```

reranker 通常更贵，不要只取 `TOP_K` 再 rerank——应该先取更大的候选池（如 `TOP_K * 5`）再重排。

## 加多轮对话

不要塞进 storage 层。扩展 `QueryOptions`：增加历史消息、自定义 `buildMessages()`、控制历史摘要与当前检索上下文的拼接顺序。默认 Prompt 是单轮问答，多轮场景要特别小心：历史消息不能覆盖「只能基于参考内容回答」的规则。

## 加权限和安全

当前只有基础 HTTP token。用于团队或公网服务，至少要补：用户身份、查询审计、知识库权限过滤、请求速率限制、模型调用成本限制、日志脱敏。

> 权限过滤应尽量在 retrieval 前完成，否则用户无权访问的 chunk 可能已进入候选和上下文。

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

## 发布前检查

```bash
pnpm typecheck
pnpm test
pnpm build
```

文档站在 `docs/` 下跑 `pnpm build`。GitHub Actions 会执行文档构建，并在非 PR 事件中上传 GitHub Pages artifact。
