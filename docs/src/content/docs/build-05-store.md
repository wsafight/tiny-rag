---
title: "B05: Embedding 与向量写入"
description: 把 ChunkRecord 批量向量化、L2 归一化，并写入本地 NDJSON 向量库。
---

现在把 `ChunkRecord[]` 变成带向量的记录，存进本地文件。`mini-rag` 不用向量数据库，向量库就是一个 NDJSON 文件：第一行放 `_meta`，后续每行放一个 chunk。

## 先理解：embedding 是可检索的索引

embedding 是模型给文本算出来的一组数字。它本身不是给人看的内容，而是给检索算法用的索引。导入时给每个 chunk 算 embedding，查询时给问题算 embedding，两者必须来自同一个 provider 和同一个 model，才有比较意义。

向量还有一个维度 `dim`，比如 768 或 1536。维度不同一定不能比较；维度相同但模型不同也不应该混用，因为向量空间不同。所以向量库的 `_meta` 要保存 provider、model、dim、chunkSize 和 chunkOverlap。

归一化也是为了检索。向量做 L2 归一化后，点积就等价于余弦相似度，查询时可以少算一次模长。

## 为什么用 NDJSON

- 写入和读取都简单，可以流式逐行处理。
- 文件能直接打开检查。
- 第一行放元数据 `_meta`，后续每行放一条 chunk，结构清晰。

代价是查询只能线性扫描，不适合超大知识库。这正是简化版的取舍：先把链路讲清楚。

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
