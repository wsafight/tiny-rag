---
title: "B04: 语义切块与 ChunkRecord"
description: 按 Markdown 标题和段落切块，长段落才按长度兜底，并生成带标题路径的 ChunkRecord。
---

整篇文档塞进 prompt 会浪费上下文，也让模型容易被无关内容干扰。用户的问题通常只需要文档里的几段。这一章把 `SourceDocument` 切成 `ChunkRecord[]`。

## 先理解：chunk 决定检索粒度

检索的最小单位不是整份文档，而是 chunk。chunk 太大，一个片段里会混入多个主题，检索命中后会把无关内容一起塞进 Prompt；chunk 太小，又可能只剩半句话，模型拿不到完整条件。

好的切块策略应该优先保留语义边界。Markdown 标题天然表达层级，段落天然表达一个小主题，所以 tiny-rag 先按标题维护 `heading` 路径，再按空行聚合段落。只有单个段落太长时，才用固定长度硬切。

`overlap` 只在硬切长文本时有意义。它保留相邻片段之间的一小段重叠，避免答案刚好落在切口两边时上下文断裂。普通按段落切出来的 chunk 不需要人为重叠。

## 切块策略

简单按固定字符数切会把一句话拦腰截断。我们用语义优先的策略：

1. 先按 Markdown 标题分段，维护标题栈生成 `headingPath`（如 `订单问题 > 取消订单`）。
2. 每段内按空行拆成段落。
3. 段落能塞进当前 buffer 就合并，塞不下就 flush 成一个 chunk。
4. 只有单个段落本身超过 `size` 时，才按长度硬切（带 overlap）。

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
