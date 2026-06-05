---
title: "B05: Embedding 与向量写入"
description: 把 ChunkRecord 转成可检索索引，解释 embedding、归一化、meta 和 NDJSON 向量库的取舍。
---

现在把 `ChunkRecord[]` 变成带向量的记录，存进本地文件。`mini-rag` 不用向量数据库，向量库就是一个 NDJSON 文件：第一行放 `_meta`，后续每行放一个 chunk。

这一章是 RAG 从“文本处理”进入“检索索引”的分界线。chunk 仍然是人能读懂的文本，embedding 则是模型给这段文本计算出的坐标。后面查询时，问题也会被映射到同一个坐标系里，再和这些 chunk 做相似度比较。

`B01 > B02 > B03 > B04 > [ B05 ] B06 | B07 > B08 > B09 > B10`

:::note[本章产出]
- **前置**：读完 `B04`，有 `ChunkRecord[]`；`B02` 的 embedding 模型可用。
- **产出**：`vector.ts`（L2 归一化）+ `store.ts`（`writeVectorStore()`），跑一次后得到一个真实的 `vector-store.ndjson` 文件。
- **核心收获**：理解 embedding 是“可检索的索引坐标”，以及 `_meta` 为什么是向量库的“说明书”。
:::

> *"embedding 不是给人看的，是可检索的索引坐标。"* —— 这一章把文本变成能比较相似度的向量。
>
> **导入阶段**：在主链路上补的是 chunk → 向量记录 → NDJSON 文件这一段。

## 问题

到上一章为止，我们手里只有 `ChunkRecord[]`——一堆带标题的文本片段。但检索不能靠字符串匹配：用户问“怎么退款”，资料里写的是“订单取消后原路返还”，字面零重合，语义却高度相关。要让机器判断“语义接近”，就得先把文本变成可计算的东西。

embedding 是模型给文本算出来的一组数字。它本身不是给人看的内容，而是给检索算法用的索引。导入时给每个 chunk 算 embedding，查询时给问题算 embedding，两者必须来自同一个 provider 和同一个 model，才有比较意义。

:::tip[原理补充：embedding 不是坐标表]
embedding 不是把文字变成一组人工可解释的标签。通常不能说“第 12 维表示退货、第 25 维表示订单”。有意义的是**两个向量之间的相对关系**：语义接近的文本，在同一个 embedding 模型的向量空间里方向更接近。排查时应该看 `source`、`heading`、`content`、`vectorScore` 和命中排序，而不是逐维解释 `embedding[12]` 这种数字。
:::

向量还有一个维度 `dim`，比如 768 或 1536。维度不同一定不能比较；维度相同但模型不同也不应该混用，因为向量空间不同。所以向量库的 `_meta` 要保存 provider、model、dim、chunkSize 和 chunkOverlap。

:::caution[维度相同也不能混用不同模型]
新手常以为“两个模型都输出 768 维向量，应该能互相比较”。其实**维度相同只是必要条件**——不同模型的向量处在不同的语义空间，硬比会得到看似有分数、实则毫无意义的结果。这正是 `_meta` 要记录 `provider` 和 `model` 的原因：查询时严格校验，宁可报错也不要默默算出错误排序。
:::

:::caution[embedding 不会记住你的文档]
把文本发给 `/embeddings` 只是得到这段文本的向量，模型参数不会因为这次调用而更新。真正保存你资料的是 `vector-store.ndjson` 或未来的向量数据库；如果没有把 chunk 写进索引，查询时就不可能从它召回证据。
:::

归一化也是为了检索。向量做 L2 归一化后，点积就等价于余弦相似度，查询时可以少算一次模长。

可以把 `_meta` 理解成向量库的“说明书”。没有 provider、model 和 dim，`embedding: [0.0123, -0.0456]` 只是数字数组；有了这些字段，查询阶段才知道当前问题向量能不能和它放在一起比较。

## 解决方案

向量库 = 一个 NDJSON 文件，第一行写说明书 `_meta`，后续每行写一条带向量的 chunk：

```text
vector-store.ndjson
  第 1 行   {"_meta": {provider, model, dim, chunkSize, chunkOverlap, ...}}
  第 2 行   {id, source, heading, content, embedding: [...]}
  第 3 行   {id, source, heading, content, embedding: [...]}
  ...
```

选 NDJSON 的理由：

- 写入和读取都简单，可以流式逐行处理。
- 文件能直接打开检查。
- 第一行放元数据 `_meta`，后续每行放一条 chunk，结构清晰。

代价是查询只能线性扫描，不适合超大知识库。这正是简化版的取舍：先把链路讲清楚。核心洞察是——**把索引格式暴露成可读文本，比塞进黑盒服务更利于理解 RAG**。学习阶段能直接打开文件看 `_meta`、`source`、`heading`、`content` 和 `embedding`，每个 bug 都能回到具体字段上解释。

## 工作原理

### 1. 归一化

新建 `vector.ts`。向量先做 L2 归一化：

```ts
// vector.ts
export function normalize(vec: readonly number[]): number[] {
  // 先计算平方和，用它开平方得到向量模长。
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  // 零向量没有方向，不能除以 0；返回拷贝，避免修改调用方原数组。
  if (norm === 0) return vec.slice();
  // 把向量缩放到长度 1；后续点积就可以当作余弦相似度使用。
  return vec.map((x) => x / norm);
}
```

归一化的意义在于统一比较尺度。否则一个向量的模长可能影响点积分数，让“长度更大”掺进“方向更相似”的判断里。做完 L2 归一化后，点积主要反映方向接近程度，也就是常说的余弦相似度。

:::tip[为什么先归一化]
直觉理解：检索真正想比较的是两段文本“**方向**像不像”（语义接近），而不是“谁的向量更长”。L2 归一化把每个向量缩放到长度 1，这样它们的点积就直接等于余弦相似度，查询时还能少算一次模长。导入和查询两端都归一化，是后面所有相似度计算的前提。
:::

### 2. 写入向量库

新建 `store.ts`。`writeVectorStore()` 先写 `_meta`，再逐行写 chunk：

```ts
// store.ts
import { writeFile } from 'node:fs/promises';
import type { VectorStoreRecord } from './types';

export interface StoreMeta {
  /** 向量库格式版本；后续结构变化时用它做兼容校验。 */
  version: number;
  /** 生成 embedding 的 provider，例如 lmstudio / ollama / openai。 */
  provider: string;
  /** 生成 embedding 的模型名；换模型后旧向量库不能复用。 */
  model: string;
  /** embedding 维度；查询向量必须与它一致。 */
  dim: number;
  /** 写库时使用的切块上限，方便复现导入参数。 */
  chunkSize: number;
  /** 写库时使用的硬切 overlap。 */
  chunkOverlap: number;
  /** 向量库生成时间，主要用于排查和展示。 */
  createdAt: string;
}

export async function writeVectorStore(
  path: string,
  meta: StoreMeta,
  records: readonly VectorStoreRecord[],
): Promise<void> {
  // 第一行固定写 _meta，查询阶段先读它判断当前模型能不能使用这个库。
  const lines = [JSON.stringify({ _meta: meta })];
  // 后续每行一条记录；NDJSON 的好处是可读、可逐行处理。
  for (const r of records) lines.push(JSON.stringify(r));
  // 文件末尾保留换行，方便命令行工具和逐行读取。
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
}
```

### 3. 写入一次

这一章先不封装 `ingest()`，只在 `main.ts` 里把前面几章串起来，确认向量库可以被写出来：

```ts
// main.ts
import { buildChunkRecords } from './chunking';
import { loadDocuments } from './documents';
import { createEmbedder } from './providers';
import { writeVectorStore, type StoreMeta } from './store';
import { normalize } from './vector';
import type { VectorStoreRecord } from './types';

const chunkSize = 600;
const chunkOverlap = 80;
const model = process.env.EMBED_MODEL ?? 'nomic-embed-text';
// createEmbedder 隐藏 HTTP 调用细节，导入流程只依赖 embed 函数。
const embed = createEmbedder({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1', model });

// 读文档和切块仍然是纯文本处理，不需要模型参与。
const docs = await loadDocuments('./documents');
const chunks = buildChunkRecords(docs, chunkSize, chunkOverlap);
// embedding 文本把 heading 放在正文前面，让模型知道片段所在主题。
const vectors = await embed(chunks.map((c) => `${c.heading}\n${c.content}`));

const records: VectorStoreRecord[] = chunks.map((chunk, i) => ({
  ...chunk,
  // 写入前统一归一化，查询时点积就能直接表示相似度。
  embedding: normalize(vectors[i]),
}));

const meta: StoreMeta = {
  version: 1,
  provider: 'lmstudio',
  model,
  // 用第一条记录的向量长度作为 dim；空库时记为 0，下一章会补更严格校验。
  dim: records[0]?.embedding.length ?? 0,
  chunkSize,
  chunkOverlap,
  createdAt: new Date().toISOString(),
};

// 向量库是后续查询阶段的唯一事实源。
await writeVectorStore('./vector-store.ndjson', meta, records);
console.log(`已写入 ${records.length} 条记录到 vector-store.ndjson`);
```

运行后打开 `vector-store.ndjson`，第一行是 `_meta`，后续每行是一条带 `embedding` 的 chunk。

这一章已经能写出向量库。下一章把读取、元数据校验和导入主流程封装起来。

到这里，导入结果第一次变成了可持久化资产。它不再只是内存里的数组，而是一个可以被 CLI、HTTP 服务和库 API 共同读取的索引文件。后面的工程化优化，基本都围绕“如何更快、更安全、更少重复地生成和读取这个文件”展开。

## 相对 B04 的变更

| 组件 | 之前 (B04) | 之后 (B05) |
| --- | --- | --- |
| 数据形态 | `ChunkRecord[]`（纯文本片段） | `VectorStoreRecord[]`（文本 + 向量） |
| 向量处理 | 无 | `vector.ts`：L2 归一化 |
| 持久化 | 无，只在内存 | `vector-store.ndjson` 文件 |
| 元数据 | 无 | `_meta`：provider / model / dim / 切块参数 |
| 可比较性 | 不涉及 | embedding 同 provider + model 才可比 |

## 试一试

把前几章和本章串起来跑一次（确保 `B02` 的 embedding 服务在线）：

```bash
npm run dev
```

然后观察：

1. 打开生成的 `vector-store.ndjson`，确认第一行是 `_meta`、后续每行带 `embedding`。
2. 数一下 `embedding` 数组长度，它应该等于 `_meta.dim`。
3. 故意改一下 `EMBED_MODEL` 再跑一次，观察 `_meta.model` 和向量都变了——这就是下一章要做 meta 校验的原因。
4. 用编辑器搜索某个 chunk 的 `content`，对照它的 `heading`，确认切块边界符合预期。

## 本章小结

- 向量库就是一个 NDJSON 文件：**第一行 `_meta`**，后续每行一条带 `embedding` 的 chunk。
- 写入前对向量做 **L2 归一化**，让点积等价于余弦相似度。
- `_meta` 是向量库的“说明书”，记录 provider / model / dim / 切块参数，是查询时能否比较的依据。
- NDJSON 的代价是只能线性扫描，不适合超大库——这是学习版刻意的取舍，换来“能直接打开看”的透明度。

:::note[下一章：B06 向量库读取与 ingest]
本章只“写得出”向量库。下一章补上**读取 + meta 校验**，并把读文档、切块、embedding、写入串成一个可复用的 `ingest()` 函数，正式收尾导入阶段。
:::
