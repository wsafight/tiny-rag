---
title: 文档解析与清洗
description: 说明 PDF、HTML、DOCX 等格式接入时，重点不是读出文本，而是清洗噪声、稳定 source 和保住切块边界。
---

tiny-rag 默认读取 `.md` / `.txt`，因为它们最透明。但真实资料经常是 PDF、HTML、DOCX、导出的表格或客服问答。扩展文件格式时，目标不是“把文件读成字符串”这么简单，而是把它们变成适合切块和回查的 `SourceDocument`。

> **扩展落点**：ingestion 层，输出仍然是 `{ source, content }`。

:::note[本章目标]
读完这一章，你应该能判断文档解析器应该负责什么、哪些噪声会破坏检索，以及为什么解析后还要配套切块策略。
:::

## 接口边界

新增格式不要影响 retrieval / query。解析器最终只需要输出：

```ts
export interface SourceDocument {
  source: string;
  content: string;
}
```

也就是说：

```text
PDF / HTML / DOCX
  -> parse + clean
  -> SourceDocument[]
  -> buildChunkRecords()
  -> embedding
```

后面的切块、embedding、检索、Prompt 都不应该知道原始文件格式。

## PDF 的问题

PDF 最大的问题是版面，不是文本。

常见噪声：

- 页眉页脚重复出现。
- 页码混入正文。
- 两栏布局顺序错乱。
- 表格被打散成不连续的行。
- 段落换行过多，导致切块误判。

如果直接把 PDF 抽出来的原始文本送去切块，chunk 可能会充满页码、页脚和断裂句子。embedding 会忠实地向量化这些噪声，检索自然变差。

## HTML 的问题

HTML 通常能拿到结构，但噪声更多：

- 导航栏、页脚、版权信息。
- 相关文章、广告、侧边栏。
- 隐藏文本和脚本内容。
- 面包屑和重复标题。

解析 HTML 时，应优先抽取正文区域，而不是整页 `innerText`。否则每个页面都会带上相似导航噪声，BM25 和 embedding 都会被污染。

## DOCX 的问题

DOCX 通常保留段落结构，但也有几个坑：

- 标题层级可能来自样式，不一定是 Markdown `#`。
- 表格内容需要决定按行、按单元格还是按整表输出。
- 批注、修订痕迹、页眉页脚要不要保留。

如果能把标题样式转成 Markdown 标题，后续 `splitSemantic()` 就能复用现有逻辑。

## 清洗原则

解析器最好同时做清洗：

| 清洗项 | 原因 |
| --- | --- |
| 删除页眉页脚 / 导航 | 避免重复噪声影响检索 |
| 合并异常换行 | 避免一句话被切碎 |
| 保留标题层级 | 给 chunk heading 提供语义背景 |
| 保留表格边界 | 避免字段和值分离 |
| 规范 source | 保证回查和缓存稳定 |

清洗不要过度。尤其是规章、合同、配置项，删除“看起来重复”的句子前要确认它不是重要条件。

## 配套切块策略

不同资料格式适合不同切块：

| 资料 | 推荐切块 |
| --- | --- |
| 长文章 / 手册 | 标题 + 段落 |
| FAQ / 客服问答 | 一个问答对一个 chunk |
| 配置项说明 | 一个配置项一个 chunk |
| 表格 | 一行或一组相关行一个 chunk |
| 合同条款 | 条款编号边界优先 |

不要先把所有内容拼成一篇长文本，再交给固定长度 splitter。解析阶段能看到结构，就应该尽量把结构保留下来。

## source 设计

source 要能回查：

```text
manual.pdf#page=12
faq.html#section=refund
policy.docx#heading=售后规则
```

source 不一定只能是文件路径。对 PDF 页码、HTML anchor、DOCX 标题，source 可以带上稳定片段定位信息。只要它稳定、可读、可回查，就能帮助诊断。

## 本章小结

- 文件格式扩展落在 ingestion 层，最终仍输出 `SourceDocument`。
- PDF / HTML / DOCX 的难点是清洗和结构保留，不是单纯读文本。
- 解析器应该尽量保留标题、表格、问答对、条款编号这些天然边界。
- source 要稳定且能回查，必要时带页码、anchor 或标题定位。

:::note[继续阅读]
解析后的文本会进入 [B04: 语义切块与 ChunkRecord](/tiny-rag/build-04-chunking/)。如果召回不稳，优先检查解析文本是否已经丢失结构。
:::
