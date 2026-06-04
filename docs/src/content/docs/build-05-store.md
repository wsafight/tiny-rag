---
title: "B05: Embedding 与向量写入"
description: 把 ChunkRecord 转成可检索索引，解释 embedding、归一化、meta 和 NDJSON 向量库的取舍。
---

现在把 `ChunkRecord[]` 变成带向量的记录，存进本地文件。`mini-rag` 不用向量数据库，向量库就是一个 NDJSON 文件：第一行放 `_meta`，后续每行放一个 chunk。

这一章是 RAG 从“文本处理”进入“检索索引”的分界线。chunk 仍然是人能读懂的文本，embedding 则是模型给这段文本计算出的坐标。后面查询时，问题也会被映射到同一个坐标系里，再和这些 chunk 做相似度比较。

:::note[本章产出]
- **前置**：读完 `B04`，有 `ChunkRecord[]`；`B02` 的 embedding 模型可用。
- **产出**：`vector.ts`（L2 归一化）+ `store.ts`（`writeVectorStore()`），跑一次后得到一个真实的 `vector-store.ndjson` 文件。
- **核心收获**：理解 embedding 是“可检索的索引坐标”，以及 `_meta` 为什么是向量库的“说明书”。
:::

> embedding = 模型给文本算出的一组数字（向量）；NDJSON = 每行一个 JSON 对象的文本文件。

## 先理解：embedding 是可检索的索引

embedding 是模型给文本算出来的一组数字。它本身不是给人看的内容，而是给检索算法用的索引。导入时给每个 chunk 算 embedding，查询时给问题算 embedding，两者必须来自同一个 provider 和同一个 model，才有比较意义。

向量还有一个维度 `dim`，比如 768 或 1536。维度不同一定不能比较；维度相同但模型不同也不应该混用，因为向量空间不同。所以向量库的 `_meta` 要保存 provider、model、dim、chunkSize 和 chunkOverlap。

:::caution[维度相同也不能混用不同模型]
新手常以为“两个模型都输出 768 维向量，应该能互相比较”。其实**维度相同只是必要条件**——不同模型的向量处在不同的语义空间，硬比会得到看似有分数、实则毫无意义的结果。这正是 `_meta` 要记录 `provider` 和 `model` 的原因：查询时严格校验，宁可报错也不要默默算出错误排序。
:::

归一化也是为了检索。向量做 L2 归一化后，点积就等价于余弦相似度，查询时可以少算一次模长。

可以把 `_meta` 理解成向量库的“说明书”。没有 provider、model 和 dim，`embedding: [0.0123, -0.0456]` 只是数字数组；有了这些字段，查询阶段才知道当前问题向量能不能和它放在一起比较。

## 为什么用 NDJSON

- 写入和读取都简单，可以流式逐行处理。
- 文件能直接打开检查。
- 第一行放元数据 `_meta`，后续每行放一条 chunk，结构清晰。

代价是查询只能线性扫描，不适合超大知识库。这正是简化版的取舍：先把链路讲清楚。

NDJSON 不是为了证明本地文件优于向量数据库，而是为了把索引格式暴露出来。学习阶段能直接打开文件看 `_meta`、`source`、`heading`、`content` 和 `embedding`，比把数据立即塞进黑盒服务更利于理解。

## 归一化

新建 `vector.ts`。向量先做 L2 归一化：

```ts
// vector.ts
export function normalize(vec: readonly number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.slice();
  return vec.map((x) => x / norm);
}
```

归一化的意义在于统一比较尺度。否则一个向量的模长可能影响点积分数，让“长度更大”掺进“方向更相似”的判断里。做完 L2 归一化后，点积主要反映方向接近程度，也就是常说的余弦相似度。

:::tip[为什么先归一化]
直觉理解：检索真正想比较的是两段文本“**方向**像不像”（语义接近），而不是“谁的向量更长”。L2 归一化把每个向量缩放到长度 1，这样它们的点积就直接等于余弦相似度，查询时还能少算一次模长。导入和查询两端都归一化，是后面所有相似度计算的前提。
:::

## 写入向量库

新建 `store.ts`。`writeVectorStore()` 先写 `_meta`，再逐行写 chunk：

```ts
// store.ts
import { writeFile } from 'node:fs/promises';
import type { VectorStoreRecord } from './types';

export interface StoreMeta {
  version: number;
  provider: string;
  model: string;
  dim: number;
  chunkSize: number;
  chunkOverlap: number;
  createdAt: string;
}

export async function writeVectorStore(
  path: string,
  meta: StoreMeta,
  records: readonly VectorStoreRecord[],
): Promise<void> {
  const lines = [JSON.stringify({ _meta: meta })];
  for (const r of records) lines.push(JSON.stringify(r));
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
}
```

## 写入一次

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
const embed = createEmbedder({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1', model });

const docs = await loadDocuments('./documents');
const chunks = buildChunkRecords(docs, chunkSize, chunkOverlap);
const vectors = await embed(chunks.map((c) => `${c.heading}\n${c.content}`));

const records: VectorStoreRecord[] = chunks.map((chunk, i) => ({
  ...chunk,
  embedding: normalize(vectors[i]),
}));

const meta: StoreMeta = {
  version: 1,
  provider: 'lmstudio',
  model,
  dim: records[0]?.embedding.length ?? 0,
  chunkSize,
  chunkOverlap,
  createdAt: new Date().toISOString(),
};

await writeVectorStore('./vector-store.ndjson', meta, records);
console.log(`已写入 ${records.length} 条记录到 vector-store.ndjson`);
```

运行后打开 `vector-store.ndjson`，第一行是 `_meta`，后续每行是一条带 `embedding` 的 chunk。

这一章已经能写出向量库。下一章把读取、元数据校验和导入主流程封装起来。

到这里，导入结果第一次变成了可持久化资产。它不再只是内存里的数组，而是一个可以被 CLI、HTTP 服务和库 API 共同读取的索引文件。后面的工程化优化，基本都围绕“如何更快、更安全、更少重复地生成和读取这个文件”展开。

## 本章小结

- 向量库就是一个 NDJSON 文件：**第一行 `_meta`**，后续每行一条带 `embedding` 的 chunk。
- 写入前对向量做 **L2 归一化**，让点积等价于余弦相似度。
- `_meta` 是向量库的“说明书”，记录 provider / model / dim / 切块参数，是查询时能否比较的依据。
- NDJSON 的代价是只能线性扫描，不适合超大库——这是学习版刻意的取舍，换来“能直接打开看”的透明度。

:::note[下一章：B06 向量库读取与 ingest]
本章只“写得出”向量库。下一章补上**读取 + meta 校验**，并把读文档、切块、embedding、写入串成一个可复用的 `ingest()` 函数，正式收尾导入阶段。
:::
