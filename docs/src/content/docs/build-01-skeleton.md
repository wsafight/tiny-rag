---
title: "B01: 项目骨架与核心类型"
description: 建立 mini-rag 的运行环境、TypeScript 配置、核心数据类型和最小入口。
---

从这一章开始，我们从零写一个简化版 RAG，命名为 `mini-rag`。它会比 tiny-rag 小很多，但主链路完全一致：读文档 → 切块 → embedding → 向量库 → 检索 → 回答。

每一章的代码片段都能直接编译运行。本章先把骨架立起来，但暂时不接模型服务。模型抽象放到下一章单独讲。

## 先理解：RAG 需要哪些积木

RAG 不是训练一个新模型，而是把外部资料接到大模型前面。最小链路只需要两种模型能力：

- **embedding**：把文本变成数字向量，后面用来检索相似片段。
- **chat**：把检索到的参考内容和用户问题放进 Prompt，生成最终回答。

这两种能力要分开看。embedding 模型决定向量库能不能复用；chat 模型只影响回答风格和生成质量。换 chat 模型通常不用重新导入资料，换 embedding 模型必须重新导入。

代码里也要先把数据形态定清楚。导入阶段的数据会从 `SourceDocument` 变成 `ChunkRecord`，再变成带向量的 `VectorStoreRecord`；查询阶段会把命中的片段包装成 `SearchHit`，最后拼成 `ChatMessage` 发给聊天模型。先定义这些类型，后面每章都是往这条数据链上补能力。

## 运行环境

`mini-rag` 只依赖 Node 内置能力，不引入向量数据库或框架。

- Node.js `>=20.19.0`（需要内置 `fetch` 和 `node:` 协议导入）
- [`tsx`](https://github.com/privatenumber/tsx)：直接运行 TypeScript，免编译步骤

新建目录并初始化：

```bash
mkdir mini-rag && cd mini-rag
npm init -y
npm pkg set type=module
npm install -D tsx typescript @types/node
```

`package.json` 里加一个运行脚本：

```json
{
  "scripts": {
    "dev": "node --import tsx main.ts"
  }
}
```

## 核心类型

新建 `types.ts`。整条链路上的数据只有三种形态，先全部定义出来：

```ts
// types.ts

/** 从磁盘读到的一份原始文档 */
export interface SourceDocument {
  source: string;
  content: string;
}

/** 切块后的一段文本，带标题路径 */
export interface ChunkRecord {
  id: string;
  source: string;
  chunkIndex: number;
  heading: string;
  content: string;
}

/** 写入向量库后，比 ChunkRecord 多了 embedding */
export interface VectorStoreRecord extends ChunkRecord {
  embedding: number[];
}

/** 检索命中后，比 ChunkRecord 多了分数 */
export interface SearchHit extends ChunkRecord {
  score: number;
}

/** 一条聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
```

记住这条主线：`SourceDocument → ChunkRecord → VectorStoreRecord`（导入阶段），`ChunkRecord → SearchHit`（查询阶段）。后面每一章都在给这些类型填上数据。

## 跑通空壳

新建 `main.ts`，先确认 TypeScript 入口能正常运行：

```ts
// main.ts
import type { SourceDocument } from './types';

const doc: SourceDocument = {
  source: 'hello.md',
  content: '# Hello\n\nmini-rag is ready.',
};

console.log(`${doc.source}: ${doc.content.length} 字符`);
```

运行：

```bash
npm run dev
```

预期输出类似：

```text
hello.md: 27 字符
```

到这里骨架就立起来了：运行环境可用，数据形态清晰。下一章单独处理模型服务，把 embedding 和 chat 抽象成可替换的函数。
