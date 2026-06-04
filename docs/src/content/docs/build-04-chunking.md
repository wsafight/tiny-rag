---
title: "B04: 语义切块与 ChunkRecord"
description: 用 Markdown 标题和段落边界做语义切块，理解 chunk 如何决定 RAG 召回质量上限。
---

整篇文档塞进 prompt 会浪费上下文，也让模型容易被无关内容干扰。用户的问题通常只需要文档里的几段。这一章把 `SourceDocument` 切成 `ChunkRecord[]`。

切块是 RAG 里最容易被调参掩盖的环节。检索器只能在 chunk 之间排序，如果答案被切得太碎、和条件分离，后面再好的向量模型也只能召回残缺证据。反过来，chunk 太大时，正确答案可能被无关内容淹没。

:::note[本章产出]
- **前置**：读完 `B03`，手上有 `SourceDocument[]`。
- **产出**：一份 `chunking.ts`，包含 `splitByLength()`（长度兜底）、`splitSemantic()`（语义切块）、`buildChunkRecords()`（组装成带 id 的 `ChunkRecord`）。
- **核心收获**：理解“**语义优先，长度兜底**”——为什么先按标题和段落切，只在段落过长时才按字数硬切。
:::

> 切块（chunking）= 把长文档拆成检索用的小片段。检索的最小单位是 chunk，不是整份文档。

## 先理解：chunk 决定检索粒度

检索的最小单位不是整份文档，而是 chunk。chunk 太大，一个片段里会混入多个主题，检索命中后会把无关内容一起塞进 Prompt；chunk 太小，又可能只剩半句话，模型拿不到完整条件。

好的切块策略应该优先保留语义边界。Markdown 标题天然表达层级，段落天然表达一个小主题，所以 tiny-rag 先按标题维护 `heading` 路径，再按空行聚合段落。只有单个段落太长时，才用固定长度硬切。

`overlap` 只在硬切长文本时有意义。它保留相邻片段之间的一小段重叠，避免答案刚好落在切口两边时上下文断裂。普通按段落切出来的 chunk 不需要人为重叠。

这里的关键词是“语义优先，长度兜底”。`CHUNK_SIZE` 不是让所有 chunk 都变成固定长度，而是给 chunk 一个上限。能按标题和段落自然成块时，就不要为了追求长度一致而打断语义。

:::tip[overlap 只在“硬切”时才有用]
`overlap`（相邻片段的重叠字数）很容易被误解成“每个 chunk 都要重叠”。其实它只在**单个段落太长、不得不按字数硬切**时才起作用：保留一小段重叠，避免答案刚好落在切口两边时上下文断裂。正常按段落切出来的 chunk 之间**不需要**人为重叠。
:::

## 切块策略

简单按固定字符数切会把一句话拦腰截断。我们用语义优先的策略：

1. 先按 Markdown 标题分段，维护标题栈生成 `headingPath`（如 `订单问题 > 取消订单`）。
2. 每段内按空行拆成段落。
3. 段落能塞进当前 buffer 就合并，塞不下就 flush 成一个 chunk。
4. 只有单个段落本身超过 `size` 时，才按长度硬切（带 overlap）。

标题路径也不是装饰字段。它会在后面至少参与三件事：作为检索结果的可读来源、作为 embedding 文本的一部分提升语义背景、作为 BM25 关键词统计里的标题信号。标题写得越清晰，检索越容易稳定。

## 长度兜底

先写硬切函数 `splitByLength()`，给超长段落兜底。相邻片段保留 overlap，避免在切口处丢失上下文：

```ts
// chunking.ts
export function splitByLength(text: string, size: number, overlap: number): string[] {
  if (overlap >= size) throw new Error('overlap 必须小于 size');
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  const step = size - overlap;
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    const slice = text.slice(start, end).trim();
    if (slice) chunks.push(slice);
    if (end === text.length) break;
    start += step;
  }
  return chunks;
}
```

## 语义切块

`splitSemantic()` 扫描每一行：遇到标题就更新标题栈，否则把内容累积到当前段落。标题栈用「弹出所有层级 ≥ 当前层级的标题」来维护路径——这样 `##` 会替换掉上一个 `##` 而保留 `#`。

```ts
// chunking.ts（续）
export interface SemanticChunk {
  heading: string;
  content: string;
}

export function splitSemantic(text: string, size: number, overlap: number): SemanticChunk[] {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');

  const sections: Array<{ heading: string; body: string }> = [];
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];
  const headingPath = () => stack.map((h) => h.title).join(' > ');

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (buffer.length) sections.push({ heading: headingPath(), body: buffer.join('\n') });
      buffer = [];
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length) sections.push({ heading: headingPath(), body: buffer.join('\n') });

  const result: SemanticChunk[] = [];
  for (const section of sections) {
    const paragraphs = section.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buf = '';
    const flush = () => {
      if (!buf.trim()) return;
      for (const sub of splitByLength(buf.trim(), size, overlap)) {
        result.push({ heading: section.heading, content: sub });
      }
      buf = '';
    };
    for (const p of paragraphs) {
      if (buf.length + p.length + 2 <= size) {
        buf = buf ? `${buf}\n\n${p}` : p;
      } else {
        flush();
        if (p.length > size) {
          for (const sub of splitByLength(p, size, overlap)) {
            result.push({ heading: section.heading, content: sub });
          }
        } else {
          buf = p;
        }
      }
    }
    flush();
  }
  return result;
}
```

## 组装 ChunkRecord

切块结果还要配上 `id`、`source`、`chunkIndex`，变成 `ChunkRecord`。新建 `buildChunkRecords()`：

```ts
// chunking.ts（续）
import type { ChunkRecord, SourceDocument } from './types';

export function buildChunkRecords(
  docs: readonly SourceDocument[],
  size: number,
  overlap: number,
): ChunkRecord[] {
  const records: ChunkRecord[] = [];
  for (const doc of docs) {
    const chunks = splitSemantic(doc.content, size, overlap);
    chunks.forEach((chunk, i) => {
      records.push({
        id: `${doc.source}#${i}`,
        source: doc.source,
        chunkIndex: i,
        heading: chunk.heading,
        content: chunk.content,
      });
    });
  }
  return records;
}
```

`id` 使用 `${source}#${chunkIndex}`，看起来简单，但它建立了从向量库记录回到原文位置的最短路径。只要读取顺序和切块规则稳定，同一份文档就会生成稳定 id，后面的缓存和调试都能复用。

## 验证

```ts
// main.ts
import { loadDocuments } from './documents';
import { buildChunkRecords } from './chunking';

const docs = await loadDocuments('./documents');
const chunks = buildChunkRecords(docs, 600, 80);
for (const c of chunks) {
  console.log(`${c.id}  [${c.heading}]  ${c.content.slice(0, 20)}...`);
}
```

运行后预期类似：

```text
faq.md#0  [订单问题 > 取消订单]  订单支付后 10 分钟内可取消。...
sub/policy.md#0  [售后规则]  7 天无理由退货。...
```

每个 chunk 都带上了标题路径。标题在两个地方还会再发挥作用：embedding 时加权、BM25 时加权。下一章先把这些 chunk 变成向量并写入本地向量库。

排查 RAG 效果时，切块结果应该优先被检查。如果命中来源对但回答缺条件，多半是 chunk 太小或标题上下文丢失；如果命中片段总是混入多个主题，通常是 chunk 太大或文档标题层级不清。先看 chunk，再看模型。

## 本章小结

- 切块采用“语义优先，长度兜底”：先按 Markdown 标题维护 `heading` 路径，再按空行聚合段落，只有段落过长才按 `size` 硬切。
- `overlap` 只服务于硬切，正常段落切块之间不重叠。
- `heading` 路径不是装饰：它后面会同时参与**命中来源展示**、**embedding 加权**、**BM25 标题加权**。
- chunk `id = ${source}#${chunkIndex}`，是从向量库记录回到原文的最短路径。

:::note[下一章：B05 Embedding 与向量写入]
chunk 还只是文本。下一章给每个 chunk 调 embedding 模型算出向量，做 L2 归一化，再连同 `_meta` 一起写进本地 NDJSON 向量库——这是 RAG 从“文本处理”跨入“检索索引”的分界线。
:::
