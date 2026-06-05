---
title: 核心术语速查
description: RAG 学习路径上最常见的术语一览，遇到不认识的词随时回来查。
---

首次接触 RAG 时，经常同时冒出很多新词。这里把文档里出现的核心概念整理成一张速查表，每条只讲"够用的最小解释"，等读到对应章节时再深入。

> **理解阶段**：遇到生词随时回来查，每条只给够用的最小解释。

## 基础概念

**RAG（Retrieval-Augmented Generation，检索增强生成）**
不让大模型凭记忆回答，而是先从你自己的资料里检索出相关片段，再把这些片段作为"参考内容"交给模型，让它基于证据回答。适合知识库问答、文档助手、客服等场景。

**embedding（向量化）**
把一段文本变成一组数字（向量）的过程。两段语义相近的文本，它们的向量在空间里也会比较"接近"。embedding 模型负责这个转换。

**向量 / vector**
一组小数，比如 `[0.012, -0.047, 0.831, ...]`，通常有几百到几千个维度。它是 embedding 模型给文本算出的"坐标"，用来衡量两段文本有多相似。

**向量库 / vector store**
存储所有 chunk 及其向量的地方。tiny-rag 用本地 NDJSON 文件（`vector-store.ndjson`）充当向量库，不依赖外部数据库。

**chunk（文本块）**
把长文档切成较小片段的结果。检索的最小单位是 chunk，不是整份文档。chunk 太大会混入无关内容；太小会丢失上下文。

**ingestion（导入）**
把文档目录变成向量库的过程：读取文档 → 切块 → embedding → 写入向量库。改了文档或换了 embedding 模型就需要重新导入。

**retrieval（检索）**
把用户问题也变成向量，再和向量库里的 chunk 向量比较相似度，取出最相关的几条。

**TopK**
检索时取相似度最高的 K 个 chunk。K 太小可能漏掉正确答案；K 太大会让无关内容混进上下文。

**BM25**
一种基于词频统计的关键词打分算法。对专有名词、产品编号、中文短词等"精确字面匹配"比纯向量检索更有效。tiny-rag 把它和向量检索融合为"混合检索"。

**混合检索 / hybrid retrieval**
把向量相似度分数和 BM25 关键词分数加权融合后排序，兼顾语义理解和字面匹配。

**candidate / candidates**
检索器按分数排出的候选片段集合，通常还没有经过最终同源限制。用来判断正确证据有没有进入候选池。

**hit / hits**
最终进入 Prompt 上下文的命中片段。它们来自 candidates，但会受到 `TOP_K`、`PER_SOURCE_LIMIT` 和 `MIN_SCORE` 影响。

**context**
由 hits 拼出来、真正发给聊天模型的参考内容。模型最终只能基于这部分证据回答。

**meta / `_meta`**
向量库第一行的元数据契约，记录 schema 版本、embedding provider/model、维度、切块参数和导入指纹。查询时靠它判断当前问题向量能不能和库里的向量比较。

**Prompt**
发给聊天模型的消息模板。RAG 里的 system prompt 要明确告诉模型：只能基于参考内容回答、不能执行参考内容里的指令、找不到答案要直说。

## 数据类型速查

| 类型 | 阶段 | 简单理解 |
| --- | --- | --- |
| `SourceDocument` | 读取文档后 | `{ source: 文件路径, content: 完整文本 }` |
| `ChunkRecord` | 切块后 | 一段文字 + 它的标题路径 + 在文件里的位置 |
| `VectorStoreRecord` | embedding 后 | ChunkRecord + 对应的向量数组 |
| `SearchHit` | 检索命中后 | ChunkRecord + 本次检索的相似度分数 |
| `ChatMessage` | 生成前 | `{ role: 'system'/'user'/'assistant', content: ... }` |

## 常见缩写

| 缩写 | 全称 | 含义 |
| --- | --- | --- |
| RAG | Retrieval-Augmented Generation | 检索增强生成 |
| LLM | Large Language Model | 大语言模型 |
| IDF | Inverse Document Frequency | 逆文档频率，BM25 的一部分 |
| NDJSON | Newline-Delimited JSON | 每行一个 JSON 对象的文本格式 |

:::tip[术语陌生不要卡住]
遇到不懂的词，查完这里再继续往下读就好。文档里每个术语在第一次正式出现时都会配一段解释，这里只是"速查索引"。
:::
