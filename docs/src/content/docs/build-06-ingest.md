---
title: "B06: 向量库读取与 ingest 主流程"
description: 读取 NDJSON 向量库、校验元数据，并把文档读取、切块、embedding、写入封装成 ingest()。
---

上一章已经能把 chunk 写进 `vector-store.ndjson`。但查询时不能直接相信这个文件：它可能是旧模型生成的，可能维度不匹配，也可能缺少 `_meta`。这一章补上读取和校验，再把导入流程封装成 `ingest()`。

## 先理解：meta 是向量库的安全边界

向量库里的 embedding 只能和同一个 embedding 模型生成的问题向量比较。`_meta` 记录了这些关键条件：

- `version`：向量库 schema 版本。
- `provider` / `model`：生成 embedding 的服务和模型。
- `dim`：向量维度。
- `chunkSize` / `chunkOverlap`：生成 chunk 时的参数。

换 embedding 模型后必须重新导入，原因就在这里：不同模型的向量空间不同，不能直接比较。

## 元数据校验

继续编辑 `store.ts`，先加 schema 版本和 `validateMeta()`：

```ts
// store.ts（续）
const SCHEMA_VERSION = 1;

export function validateMeta(meta: StoreMeta, provider: string, model: string, dim: number): void {
  if (meta.version !== SCHEMA_VERSION) throw new Error(`schema 版本不匹配: ${meta.version}`);
  if (meta.provider !== provider) throw new Error(`provider 不匹配: ${meta.provider} != ${provider}`);
  if (meta.model !== model) throw new Error(`model 不匹配: ${meta.model} != ${model}`);
  if (meta.dim !== dim) throw new Error(`维度不匹配: ${meta.dim} != ${dim}`);
}

export { SCHEMA_VERSION };
```

## 读取向量库

`loadVectorStore()` 逐行读：第一行解析 `_meta`，其余解析成记录。

```ts
// store.ts（续）
import { readFile } from 'node:fs/promises';

export interface LoadedStore {
  meta: StoreMeta;
  records: VectorStoreRecord[];
}

export async function loadVectorStore(path: string): Promise<LoadedStore> {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]) as { _meta?: StoreMeta };
  if (!first._meta) throw new Error('向量库缺少 _meta');
  const records = lines.slice(1).map((line) => JSON.parse(line) as VectorStoreRecord);
  return { meta: first._meta, records };
}
```

> 真实 tiny-rag 还会做更多格式校验和坏行提示。这里先保留最小实现，重点是看清读取边界。

## 导入主流程

新建 `ingest.ts`，把读文档、切块、embedding、归一化、写入串成一个函数：

```ts
// ingest.ts
import { loadDocuments } from './documents';
import { buildChunkRecords } from './chunking';
import { writeVectorStore, SCHEMA_VERSION, type StoreMeta } from './store';
import { normalize } from './vector';
import type { EmbedFunction } from './providers';
import type { VectorStoreRecord } from './types';

export interface IngestOptions {
  documentsDir: string;
  storePath: string;
  embed: EmbedFunction;
  provider: string;
  model: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export async function ingest(opts: IngestOptions): Promise<number> {
  const chunkSize = opts.chunkSize ?? 600;
  const chunkOverlap = opts.chunkOverlap ?? 80;

  const docs = await loadDocuments(opts.documentsDir);
  const chunks = buildChunkRecords(docs, chunkSize, chunkOverlap);
  if (chunks.length === 0) return 0;

  const vectors = await opts.embed(chunks.map((c) => `${c.heading}\n${c.content}`));
  const records: VectorStoreRecord[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: normalize(vectors[i]),
  }));

  const meta: StoreMeta = {
    version: SCHEMA_VERSION,
    provider: opts.provider,
    model: opts.model,
    dim: records[0].embedding.length,
    chunkSize,
    chunkOverlap,
    createdAt: new Date().toISOString(),
  };
  await writeVectorStore(opts.storePath, meta, records);
  return records.length;
}
```

## 验证

`main.ts` 现在只负责创建 embedder，然后调用 `ingest()`：

```ts
// main.ts
import { ingest } from './ingest';
import { createEmbedder } from './providers';

const model = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const embed = createEmbedder({ baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1', model });

const count = await ingest({
  documentsDir: './documents',
  storePath: './vector-store.ndjson',
  embed,
  provider: 'lmstudio',
  model,
});
console.log(`已写入 ${count} 条记录到 vector-store.ndjson`);
```

到这里，导入阶段完成了：文档已经变成可读取、可校验的本地向量库。下一章开始查询阶段，把问题向量和这些 chunk 比对。
