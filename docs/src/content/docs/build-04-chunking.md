---
title: "B04: 语义切块与 ChunkRecord"
description: 用 Markdown 标题和段落边界做语义切块，理解 chunk 如何决定 RAG 召回质量上限。
---

整篇文档塞进 prompt 会浪费上下文，也让模型容易被无关内容干扰。用户的问题通常只需要文档里的几段。这一章把 `SourceDocument` 切成 `ChunkRecord[]`。

切块是 RAG 里最容易被调参掩盖的环节。检索器只能在 chunk 之间排序，如果答案被切得太碎、和条件分离，后面再好的向量模型也只能召回残缺证据。反过来，chunk 太大时，正确答案可能被无关内容淹没。

`B01 > B02 > B03 > [ B04 ] B05 > B06 | B07 > B08 > B09 > B10`

:::note[本章产出]
- **前置**：读完 `B03`，手上有 `SourceDocument[]`。
- **产出**：一份 `chunking.ts`，包含 `splitByLength()`（长度兜底）、`splitSemantic()`（语义切块）、`buildChunkRecords()`（组装成带 id 的 `ChunkRecord`）。
- **核心收获**：理解“**语义优先，长度兜底**”——为什么先按标题和段落切，只在段落过长时才按字数硬切。
:::

> *"检索的最小单位是 chunk，不是文档。"* —— 切得好不好，直接决定召回质量的上限。
>
> **导入阶段**：在主链路上补的是 `SourceDocument` → `ChunkRecord[]` 这一段语义切块。

## 问题

整篇文档塞进 Prompt 是个坏主意：用户问“怎么退款”，却把整份 50 页手册全喂进去，既浪费上下文，又让模型被无关章节带偏。检索的最小单位不是整份文档，而是 chunk。chunk 太大，一个片段里会混入多个主题，检索命中后会把无关内容一起塞进 Prompt；chunk 太小，又可能只剩半句话，模型拿不到完整条件。

好的切块策略应该优先保留语义边界。Markdown 标题天然表达层级，段落天然表达一个小主题，所以 tiny-rag 先按标题维护 `heading` 路径，再按空行聚合段落。只有单个段落太长时，才用固定长度硬切。

`overlap` 只在硬切长文本时有意义。它保留相邻片段之间的一小段重叠，避免答案刚好落在切口两边时上下文断裂。普通按段落切出来的 chunk 不需要人为重叠。

这里的关键词是“语义优先，长度兜底”。`CHUNK_SIZE` 不是让所有 chunk 都变成固定长度，而是给 chunk 一个上限。能按标题和段落自然成块时，就不要为了追求长度一致而打断语义。

:::tip[overlap 只在“硬切”时才有用]
`overlap`（相邻片段的重叠字数）很容易被误解成“每个 chunk 都要重叠”。其实它只在**单个段落太长、不得不按字数硬切**时才起作用：保留一小段重叠，避免答案刚好落在切口两边时上下文断裂。正常按段落切出来的 chunk 之间**不需要**人为重叠。
:::

:::tip[先看资料结构，再选切块策略]
不是所有资料都应该按长度或 Markdown 标题切。FAQ、客服问答、配置项说明这类内容，本身就有清楚的业务边界，最好让一个问答对或一个规则条目成为一个 chunk；合同、手册、长文章才更适合标题 + 段落的语义切块。固定 token splitter 只能当兜底，不应该替代对资料结构的判断。
:::

## 解决方案

简单按固定字符数切会把一句话拦腰截断。我们用语义优先的策略：

1. 先按 Markdown 标题分段，维护标题栈生成 `headingPath`（如 `订单问题 > 取消订单`）。
2. 每段内按空行拆成段落。
3. 段落能塞进当前 buffer 就合并，塞不下就 flush 成一个 chunk。
4. 只有单个段落本身超过 `size` 时，才按长度硬切（带 overlap）。

标题路径也不是装饰字段。它会在后面至少参与三件事：作为检索结果的可读来源、作为 embedding 文本的一部分提升语义背景、作为 BM25 关键词统计里的标题信号。标题写得越清晰，检索越容易稳定。

核心洞察是——**语义优先，长度兜底：能按标题、段落或业务条目自然成块时就别为凑长度打断语义，`CHUNK_SIZE` 只是上限不是目标**。

## 工作原理

### 1. 长度兜底

先写硬切函数 `splitByLength()`，给超长段落兜底。相邻片段保留 overlap，避免在切口处丢失上下文：

```ts
// chunking.ts
export function splitByLength(text: string, size: number, overlap: number): string[] {
  // overlap 不能大于等于 size，否则 start 每次前进不了，循环会卡住。
  if (overlap >= size) throw new Error('overlap 必须小于 size');
  // 文本本来就不超过上限时，保持原样返回，避免无意义切分。
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  // step 是相邻 chunk 起点之间的距离；overlap 越大，step 越小。
  const step = size - overlap;
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    // trim 掉切口两端空白，避免写入只有空白的 chunk。
    const slice = text.slice(start, end).trim();
    if (slice) chunks.push(slice);
    // 已经切到末尾就退出，否则下一轮保留 overlap 后继续。
    if (end === text.length) break;
    start += step;
  }
  return chunks;
}
```

### 2. 语义切块

`splitSemantic()` 扫描每一行：遇到标题就更新标题栈，否则把内容累积到当前段落。标题栈用「弹出所有层级 ≥ 当前层级的标题」来维护路径——这样 `##` 会替换掉上一个 `##` 而保留 `#`。

```ts
// chunking.ts（续）
export interface SemanticChunk {
  /** 当前 chunk 所在的 Markdown 标题路径。 */
  heading: string;
  /** chunk 正文；这里还不包含 embedding。 */
  content: string;
}

export function splitSemantic(text: string, size: number, overlap: number): SemanticChunk[] {
  // 统一换行符，避免 Windows/Unix 文档在切块时表现不同。
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');

  // sections 先保存“标题路径 + 标题下正文”，第二步再按段落聚合。
  const sections: Array<{ heading: string; body: string }> = [];
  // stack 保存当前标题层级，例如 # A / ## B 会形成 A > B。
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];
  const headingPath = () => stack.map((h) => h.title).join(' > ');

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      // 遇到新标题前，先把前一个标题下积累的正文收束成 section。
      if (buffer.length) sections.push({ heading: headingPath(), body: buffer.join('\n') });
      buffer = [];
      const level = m[1].length;
      // 同级或更深层标题已经结束，弹出后再压入当前标题。
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
    } else {
      // 普通行先累积，等遇到下一个标题或文件结束时再处理。
      buffer.push(line);
    }
  }
  if (buffer.length) sections.push({ heading: headingPath(), body: buffer.join('\n') });

  const result: SemanticChunk[] = [];
  for (const section of sections) {
    // 空行分隔通常对应自然段，是比固定长度更可靠的语义边界。
    const paragraphs = section.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buf = '';
    const flush = () => {
      if (!buf.trim()) return;
      // buf 仍可能超过 size，所以最后再用长度兜底切一次。
      for (const sub of splitByLength(buf.trim(), size, overlap)) {
        result.push({ heading: section.heading, content: sub });
      }
      buf = '';
    };
    for (const p of paragraphs) {
      if (buf.length + p.length + 2 <= size) {
        // 当前段落还能放进 buffer，就保留段落边界一起合并。
        buf = buf ? `${buf}\n\n${p}` : p;
      } else {
        flush();
        if (p.length > size) {
          // 单段过长时才硬切；普通段落之间不人为制造 overlap。
          for (const sub of splitByLength(p, size, overlap)) {
            result.push({ heading: section.heading, content: sub });
          }
        } else {
          // 当前段落本身不长，作为新 buffer 的起点。
          buf = p;
        }
      }
    }
    flush();
  }
  return result;
}
```

### 3. 组装 ChunkRecord

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
    // 每份文档独立切块，chunkIndex 只在当前 source 内递增。
    const chunks = splitSemantic(doc.content, size, overlap);
    chunks.forEach((chunk, i) => {
      records.push({
        // 稳定 id 依赖稳定 source 和稳定切块规则，后续缓存和回查都靠它。
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

### 4. 验证

```ts
// main.ts
import { loadDocuments } from './documents';
import { buildChunkRecords } from './chunking';

// 先读取整篇文档，再切成检索粒度更合适的 chunk。
const docs = await loadDocuments('./documents');
const chunks = buildChunkRecords(docs, 600, 80);
for (const c of chunks) {
  // 观察 id、heading 和正文开头，是排查切块质量最快的方式。
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

## 相对 B03 的变更

| 组件 | 之前 (B03) | 之后 (B04) |
| --- | --- | --- |
| 数据形态 | `SourceDocument[]`（整篇文档） | `ChunkRecord[]`（带标题的小片段） |
| 切块策略 | 无 | `splitSemantic()`：标题 + 段落优先 |
| 长度控制 | 无 | `splitByLength()`：超长段落带 overlap 硬切 |
| 标题信息 | 仅整篇 | `heading` 路径（如 `订单问题 > 取消订单`） |
| 记录标识 | 无 | `id = ${source}#${chunkIndex}`，可回溯原文 |

## 试一试

把读文档和切块串起来跑一次，直接观察 chunk 边界：

```bash
npm run dev
```

然后观察：

1. 看每个 chunk 的 `heading` 路径是否符合文档的标题层级。
2. 调大 `CHUNK_SIZE`（如 600 → 1200）再跑，确认相邻段落被合并进了同一个 chunk。
3. 找一段超过 `size` 的长段落，确认它被硬切成多段且相邻片段有 overlap 重叠。
4. 数一下同一份文档两次运行生成的 `id` 是否完全一致——稳定 id 是后面缓存和调试的前提。

## 本章小结

- 切块采用“语义优先，长度兜底”：先按 Markdown 标题维护 `heading` 路径，再按空行聚合段落，只有段落过长才按 `size` 硬切。
- FAQ / 问答对 / 规则条目这类资料要优先按业务边界切，不要让固定长度切分把问题和答案拆开。
- `overlap` 只服务于硬切，正常段落切块之间不重叠。
- `heading` 路径不是装饰：它后面会同时参与**命中来源展示**、**embedding 加权**、**BM25 标题加权**。
- chunk `id = ${source}#${chunkIndex}`，是从向量库记录回到原文的最短路径。

:::note[下一章：B05 Embedding 与向量写入]
chunk 还只是文本。下一章给每个 chunk 调 embedding 模型算出向量，做 L2 归一化，再连同 `_meta` 一起写进本地 NDJSON 向量库——这是 RAG 从“文本处理”跨入“检索索引”的分界线。
:::
