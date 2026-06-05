---
title: "B06: 向量库读取与 ingest"
description: 把导入链路封装成 ingest()，并用向量库 meta 校验守住 embedding 空间的一致性。
---

上一章已经能把 chunk 写进 `vector-store.ndjson`。但查询时不能直接相信这个文件：它可能是旧模型生成的，可能维度不匹配，也可能缺少 `_meta`。这一章补上读取和校验，再把导入流程封装成 `ingest()`。

从这一章开始，`mini-rag` 不再只是“一次性脚本”。向量库会被写入、保存、再次读取，甚至被另一个进程读取。只要数据跨过了进程边界，就必须有校验。否则错误不会在导入时暴露，而会在查询排序异常、回答跑偏时才出现。

`B01 > B02 > B03 > B04 > B05 > [ B06 ] | B07 > B08 > B09 > B10`

:::note[本章产出]
- **前置**：读完 `B05`，能写出 `vector-store.ndjson`。
- **产出**：在 `store.ts` 补上 `validateMeta()` 和 `loadVectorStore()`，并新建 `ingest.ts` 把导入全流程封装成一个 `ingest()` 函数。
- **里程碑**：本章结束，**导入阶段完整收尾**——文档已能变成可读取、可校验的本地向量库。
:::

> *"导入是一次可重复的索引构建，hash 缓存只省钱不改语义。"* —— 跨进程的数据必须自带校验契约。
>
> **导入阶段**：在主链路上补的是 `vector-store.ndjson` 的读取 + meta 校验，并把全流程收束成 `ingest()`。

## 问题

向量库一旦落地成文件，查询阶段就不能盲目信任它：它可能是上周用旧模型生成的，可能维度对不上，也可能根本缺了 `_meta`。这些问题不会在导入时报错，而是等到查询排序异常、回答跑偏时才暴露。向量库里的 embedding 只能和同一个 embedding 模型生成的问题向量比较。`_meta` 记录了这些关键条件：

- `version`：向量库 schema 版本。
- `provider` / `model`：生成 embedding 的服务和模型。
- `dim`：向量维度。
- `chunkSize` / `chunkOverlap`：生成 chunk 时的参数。

换 embedding 模型后必须重新导入，原因就在这里：不同模型的向量空间不同，不能直接比较。

:::caution[meta 校验是“早失败”的关键]
RAG 里最难排查的 bug 是“看起来能跑，但分数全都不对”。`validateMeta()` 在读取向量库后**立刻**对比 provider / model / dim，一旦发现和当前 embedding 模型不一致就直接抛错。宁可在查询开始时清晰报错，也不要让不匹配的向量一路流到检索和 Prompt，最后变成一个谁也看不懂的“回答跑偏”。
:::

可以把 `ingest()` 看成一次构建过程，把 `vector-store.ndjson` 看成构建产物。构建产物必须携带足够的信息，让查询阶段判断“我能不能用它”。`_meta` 记录的不是展示信息，而是运行时正确性的前置条件。

## 解决方案

把导入收束成一条可重复的构建流水线，并在产物两端立起校验闸门：

```text
ingest():  文档目录 → 切块 → embedding → 归一化 → 写入 vector-store.ndjson(+_meta)
读取:      vector-store.ndjson → loadVectorStore() → validateMeta() 校验 provider/model/dim → records
```

核心洞察是——**导入是一次可重复的索引构建，产物必须自带 `_meta` 契约，查询前严格校验、宁可早失败也不让不匹配的向量混进检索**。

## 工作原理

### 1. 元数据校验

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

这个校验故意在读取后尽早执行。RAG 系统里最难排查的是“看起来能跑，但分数全都不对”。比起让错误继续流到检索和 Prompt 阶段，发现 provider、model 或 dim 不一致时直接失败，是更便宜的调试路径。

### 2. 读取向量库

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
读取函数不要顺手做检索，也不要顺手创建模型 provider。它只负责把文件还原成 `{ meta, records }`。这种小边界会让后面的 HTTP 服务很舒服：启动时读取一次，创建 retriever，然后每个请求复用内存数据。

### 3. 导入主流程

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

`ingest()` 的价值是把导入阶段收束成一个可调用的库函数。CLI 可以调用它，测试可以调用它，将来后台任务也可以调用它。入口层只负责准备参数和展示结果，真正的 RAG 导入逻辑留在核心库里。

### 4. 验证

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

本章最重要的结论是：向量库不是“写进去就完了”的缓存文件，而是带契约的索引产物。只要查询阶段严格校验这个契约，就能避免不同 embedding 空间混用造成的隐性错误。

## 相对 B05 的变更

| 组件 | 之前 (B05) | 之后 (B06) |
| --- | --- | --- |
| 写入能力 | 只有 `writeVectorStore()` | 补上 `loadVectorStore()` 读取 |
| meta 校验 | 无 | `validateMeta()`：version / provider / model / dim |
| schema 版本 | 隐式 | 显式 `SCHEMA_VERSION` 常量 |
| 导入流程 | 散落在 `main.ts` | 收束成 `ingest()` 库函数 |
| 复用性 | 仅脚本一次性运行 | CLI / 测试 / 后台任务都可调用 |

## 试一试

调用封装好的 `ingest()` 跑一次完整导入（确保 `B02` 的 embedding 服务在线）：

```bash
npm run dev
```

然后观察：

1. 确认 `ingest()` 返回的写入条数和 `vector-store.ndjson` 的非 `_meta` 行数一致。
2. 手动改坏文件第一行的 `model` 字段，再用 `loadVectorStore()` + `validateMeta()` 读取，确认它在查询前就抛错。
3. 改 `EMBED_MODEL` 重跑，对比 `_meta.model`，体会“换模型必须重新导入”。
4. 删掉文件第一行的 `_meta`，确认 `loadVectorStore()` 直接报“向量库缺少 _meta”。

## 本章小结

- `validateMeta()` 在读取后立刻校验 version / provider / model / dim，做到“早失败”。
- `loadVectorStore()` 只负责把文件还原成 `{ meta, records }`，不顺手做检索或建 provider——边界清晰，HTTP 服务才好复用。
- `ingest()` 把读文档、切块、embedding、归一化、写入收束成一个库函数，CLI、测试、后台任务都能调。
- **导入阶段到此完整**：从文档目录到可校验的本地向量库，整条链路打通。

:::note[下一章：B07 纯向量检索与 TopK]
导入做完，进入查询阶段。下一章把用户问题也变成向量，和库里每条 chunk 算相似度，取出 TopK——这是检索最纯粹的形态，后两章再加关键词和混合排序。
:::
