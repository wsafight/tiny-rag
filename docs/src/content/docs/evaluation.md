---
title: RAG 回归评测
description: 用固定问题集、期望 source、无答案用例和分数记录，让 RAG 调参从凭感觉变成可复现的回归检查。
---

RAG 做到能回答以后，下一步不是继续加功能，而是先建立一组固定评测。否则每次改 `CHUNK_SIZE`、`KEYWORD_WEIGHT`、Prompt 或模型，都只能凭几次手工问答判断“好像变好了”。

> **扩展落点**：评测不改变主链路，但会约束每次改动是否真的更好。

:::note[本章目标]
这一章给出一个最小 RAG 回归评测方法：准备哪些问题、记录哪些字段、怎么判断通过，以及如何把它接到 tiny-rag 的 CLI / 库 API / CI 里。
:::

## 为什么要评测

RAG 的质量不是只看最终回答顺不顺。一个回答可能很流畅，但引用错 source；也可能命中了正确资料，却因为 Prompt 没有约束好而编造了额外结论。

最小评测至少要拆成四层：

| 层 | 关心什么 |
| --- | --- |
| 召回 | 正确资料是否进入 `candidates` |
| 选择 | 正确资料是否进入最终 `hits` |
| 生成 | 回答是否只基于 `context` |
| 拒答 | 无答案问题是否返回 unknown |

如果只看 `answer`，你不知道问题发生在召回、排序、上下文选择还是生成。

## 固定问题集

建议用 JSONL 保存评测集，一行一个问题：

```json
{"id":"refund-001","question":"7 天能退货吗？","expectedSources":["policy.md"],"mustContain":["7 天"],"type":"answerable"}
{"id":"order-001","question":"怎么取消订单？","expectedSources":["faq.md"],"mustContain":["取消"],"type":"answerable"}
{"id":"none-001","question":"公司年假怎么申请？","expectedSources":[],"mustContain":["抱歉，参考内容中没有相关信息"],"type":"unanswerable"}
```

字段不要一开始设计太复杂。先保留：

- `id`：稳定用例名，方便对比历史结果。
- `question`：用户问题。
- `expectedSources`：期望至少命中的 source。
- `mustContain`：回答里必须出现的关键字或短语。
- `type`：`answerable` 或 `unanswerable`。

## 评测什么

### 1. source 是否命中

先看正确资料是否进入 `candidates`，再看是否进入 `hits`。

```text
expectedSources = ["policy.md"]
candidates.source 包含 policy.md  -> 召回通过
hits.source 包含 policy.md        -> 上下文选择通过
```

如果 source 没进 `candidates`，问题在导入、切块、embedding 或关键词；如果进了 `candidates` 但没进 `hits`，问题通常在 `TOP_K`、`PER_SOURCE_LIMIT` 或最终排序。

### 2. 回答是否有证据边界

`mustContain` 只适合做粗粒度检查。更重要的是看回答有没有超出参考内容。

```text
问题：7 天能退货吗？
参考：7 天无理由退货。
合格：可以，支持 7 天无理由退货。[1]
不合格：可以，且 15 天内也能换货。[1]
```

后者虽然看起来更完整，但“15 天换货”没有证据支持，应判失败。

### 3. 无答案是否拒答

无答案用例很重要。RAG 的可靠性不只体现在“知道时能答”，也体现在“不知道时不编”。

```text
type = unanswerable
expectedSources = []
answer 应该等于或包含 UNKNOWN_ANSWER
hits 最好为空，或全部低于 MIN_SCORE 后被过滤
```

如果无答案问题总能生成一段像真的回答，先看 `MIN_SCORE`、Prompt 的 unknown 规则，以及 `hits` 是否混入弱相关片段。

## 记录结果

每次评测至少保存这些字段：

```json
{
  "id": "refund-001",
  "question": "7 天能退货吗？",
  "candidateSources": ["policy.md", "faq.md"],
  "hitSources": ["policy.md"],
  "scores": [{"source": "policy.md", "score": 0.82, "vectorScore": 0.71, "keywordScore": 1}],
  "answer": "可以，支持 7 天无理由退货。[1]",
  "passed": true
}
```

这份结果比只保存 answer 更有价值。下次修改检索参数后，你可以看到是 source 排名变了，还是生成变了。

## 自动化边界

最小自动化可以先做规则检查：

- `expectedSources` 是否出现在 `candidates` 或 `hits`。
- `mustContain` 是否出现在 `answer`。
- `unanswerable` 是否返回 unknown。
- `answer` 是否包含引用编号。

不要一开始就让大模型给大模型打分。LLM-as-judge 可以后续加入，但它本身也需要校准。对 tiny-rag 这种小项目，source 命中和拒答边界通常更稳定。

## 什么时候跑

这些改动后建议跑评测：

| 改动 | 为什么 |
| --- | --- |
| 改 `CHUNK_SIZE` / `CHUNK_OVERLAP` | 影响答案条件是否留在同一 chunk |
| 改 embedding 模型 | 影响向量空间和召回排序 |
| 改 `KEYWORD_WEIGHT` | 影响语义和字面信号的平衡 |
| 改 `TOP_K` / `PER_SOURCE_LIMIT` | 影响最终进入 Prompt 的证据 |
| 改 Prompt | 影响引用、拒答和答案边界 |
| 加 reranker / 向量数据库 | 影响候选排序和召回行为 |

## 本章小结

- RAG 评测要拆开看：source 召回、hits 选择、答案边界、无答案拒答。
- 固定问题集比临时手问可靠，尤其适合比较参数修改前后的效果。
- 先用规则检查，不要一开始依赖 LLM judge。
- 评测结果要保存 `candidates`、`hits`、分数和 answer，否则很难定位退化发生在哪一层。

:::note[继续阅读]
如果某个用例失败，回到 [诊断与解析方法](/tiny-rag/diagnostics/) 沿 `documents -> chunks -> candidates -> hits -> context -> answer` 找第一处证据断裂点。
:::
