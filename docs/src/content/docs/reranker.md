---
title: Reranker 重排
description: 解释 reranker 应该放在 candidates 和 hits 之间，解决排序问题而不是召回问题。
---

向量检索和 BM25 负责先拿到一批候选。reranker 的作用是对这批候选做更细的相关性判断，把真正能回答问题的片段排到前面。

> **扩展落点**：query 层，放在 `retriever.search()` 之后、`selectDiverseHits()` 之前。

:::note[本章目标]
读完这一章，你应该能判断什么时候需要 reranker、它放在哪一层、候选池应该取多大，以及它不能解决哪些问题。
:::

## 它解决什么

纯向量和 BM25 都是召回友好的信号，但不一定能做最细的排序。

例如：

```text
问题：超过 10 分钟还能取消订单吗？

候选 A：订单支付后 10 分钟内可取消。
候选 B：订单问题可以联系人工客服。
候选 C：退款会在 3 个工作日内到账。
```

向量检索可能觉得 A、B 都相关；reranker 会更关注“超过 10 分钟还能不能取消”这个具体判断，把 A 排得更靠前。

## 放在哪里

推荐结构：

```text
question
  -> embed
  -> retriever.search(topN)  // 取较大的 candidates
  -> rerank(question, candidates)
  -> selectDiverseHits()
  -> buildContext()
  -> chat()
```

不要只取 `TOP_K` 再 rerank。正确做法是先取更大的候选池，例如：

```text
candidateTopN = TOP_K * 5
```

然后 reranker 从这批候选里挑最终 `TOP_K`。

## 不能修复什么

reranker 只能重排已有候选，不能凭空找回没召回的资料。

| 现象 | reranker 是否有用 |
| --- | --- |
| 正确片段在 candidates 里但排名靠后 | 有用 |
| 正确片段完全不在 candidates 里 | 没用 |
| chunk 把答案切断了 | 没用 |
| 文档没有导入 | 没用 |
| 权限过滤把正确片段过滤掉 | 没用 |

所以加 reranker 前，先在 `diagnostics.md` 的方法里确认正确片段已经进入 `candidates`。

## 接口形状

可以把 reranker 设计成纯函数：

```ts
export type RerankFunction = (
  question: string,
  candidates: readonly SearchHit[],
) => Promise<SearchHit[]>;
```

它接收问题和候选，返回重新排序后的候选。这样 query 编排只多一步，不需要知道 reranker 背后是本地模型、远程 API 还是规则函数。

## 分数处理

reranker 通常会输出自己的相关性分数。建议保留原始检索分和重排分：

```text
vectorScore
keywordScore
score          // 原融合分
rerankScore    // 重排分
```

不要直接覆盖所有分数。否则排查时看不出是原始召回差，还是 reranker 判断错。

## 成本与延迟

reranker 通常比向量点积贵得多，因为它可能要逐对判断：

```text
(question, candidate1)
(question, candidate2)
...
(question, candidateN)
```

所以候选池不能无限扩大。一个常见起点是：

```text
TOP_K = 4
candidateTopN = 20
```

如果延迟太高，优先减少候选池，或只对分数接近的候选重排。

## 本章小结

- reranker 放在 candidates 和 hits 之间，解决“候选里有答案但排序不够好”。
- 先取更大的候选池再重排，不要只拿 `TOP_K` 重排。
- reranker 不能修复召回失败、切块失败和权限过滤错误。
- 保留 `rerankScore` 与原始分数，方便诊断。

:::note[继续阅读]
加 reranker 前先看 [RAG 回归评测](/tiny-rag/evaluation/)，确保你能比较“加之前”和“加之后”的 source 命中与排序变化。
:::
