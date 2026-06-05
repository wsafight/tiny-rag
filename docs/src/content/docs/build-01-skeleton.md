---
title: "B01: 项目骨架与核心类型"
description: 从空项目开始搭 mini-rag，先用类型把 RAG 的数据流和模块边界钉住。
---

从这一章开始，我们从零写一个简化版 RAG，命名为 `mini-rag`。它会比 tiny-rag 小很多，但主链路完全一致：读文档 → 切块 → embedding → 向量库 → 检索 → 回答。

每一章的代码片段都能直接编译运行。本章先把骨架立起来，但暂时不接模型服务。模型抽象放到下一章单独讲。

这一章看似只是初始化项目，实际是在定整套系统的“词汇表”。RAG 项目如果一开始不区分原始文档、切块、向量记录和检索命中，后面很容易把字段混在一起，导致导入、检索和回答阶段互相泄漏细节。

`[ B01 ] B02 > B03 > B04 > B05 > B06 | B07 > B08 > B09 > B10`

> *"先定词汇表，再写逻辑。"* —— 5 个类型钉住整条数据流，后面每章都只是往这条链上补数据。
>
> **导入阶段**：这一章还不接模型，只立项目骨架和贯穿全书的核心类型。

:::note[本章产出]
- **前置**：已安装 Node.js `>=20.19.0`，会用命令行执行 `npm` 命令。不需要任何 RAG 背景。
- **产出**：一个能跑 `npm run dev` 的空项目，外加一份 `types.ts`——它定义了贯穿全书的 5 个核心数据类型。
- **本章不做**：还不接 embedding / chat 模型（下一章才接），所以现在不需要任何模型服务。
:::

## 问题

从零搭 RAG 时，最容易犯的错不是写错算法，而是**一开始不分清数据形态**：把原始文档、切块、带向量的记录、检索命中混在同一个对象里传来传去。结果导入阶段的字段泄漏到查询阶段，调试时根本分不清某个 bug 出在切块还是检索。

RAG 不是训练一个新模型，而是把外部资料接到大模型前面。最小链路只需要两种模型能力：

- **embedding**：把文本变成数字向量，后面用来检索相似片段。
- **chat**：把检索到的参考内容和用户问题放进 Prompt，生成最终回答。

这两种能力要分开看。embedding 模型决定向量库能不能复用；chat 模型只影响回答风格和生成质量。换 chat 模型通常不用重新导入资料，换 embedding 模型必须重新导入。

:::caution[记住这条区别]
**embedding 模型**和**chat 模型**是两个独立的东西，全书会反复用到这条区别：
- 换 **chat 模型**（换个更聪明的回答模型）→ 向量库照旧，不用重新导入。
- 换 **embedding 模型**（换个文本向量化模型）→ 整个向量库作废，必须重新 `ingest`。

原因在 `B05`/`B06` 会讲清楚：不同 embedding 模型的向量处在不同的坐标系，没法互相比较。
:::

代码里也要先把数据形态定清楚。导入阶段的数据会从 `SourceDocument` 变成 `ChunkRecord`，再变成带向量的 `VectorStoreRecord`；查询阶段会把命中的片段包装成 `SearchHit`，最后拼成 `ChatMessage` 发给聊天模型。先定义这些类型，后面每章都是往这条数据链上补能力。

这里先不写类，也不急着引入框架。原因很简单：RAG 的复杂度主要来自数据生命周期，而不是对象层级。用 TypeScript interface 把每个阶段的字段固定下来，比一开始设计一堆抽象更有价值。

读后面章节时可以一直拿这几个类型当地图：

## 解决方案

用 5 个 TypeScript interface 把数据每个阶段的形态钉死，让导入和查询各走各的形态，绝不互相泄漏字段：

```text
导入阶段  SourceDocument → ChunkRecord → VectorStoreRecord
查询阶段  ChunkRecord → SearchHit → ChatMessage
```

核心洞察是——**RAG 的复杂度主要来自数据生命周期，而不是对象层级**。先把字段固定下来，比一开始设计一堆抽象更有价值。

| 类型 | 出现阶段 | 关键问题 |
| --- | --- | --- |
| `SourceDocument` | 文档读取后 | 这份资料来自哪里，内容是什么 |
| `ChunkRecord` | 切块后 | 片段边界、标题路径和稳定 id 是什么 |
| `VectorStoreRecord` | embedding 后 | 这个 chunk 在向量空间里的位置是什么 |
| `SearchHit` | 检索后 | 它和当前问题有多相关 |
| `ChatMessage` | 生成前 | 模型最终能看到什么指令和上下文 |

## 工作原理

### 1. 运行环境

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

### 2. 核心类型

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

这个设计还有一个隐含好处：每一步都可以单独测试。读取文档不需要模型，切块不需要网络，检索可以用假 embedding 验证排序，Prompt 可以用固定 hits 验证消息结构。对一个学习项目来说，这比“跑起来一次”更重要，因为你能定位是哪一段逻辑出了问题。

### 3. 跑通空壳

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

本章的成果不是功能，而是边界。后面每新增一块能力，都只是在这些类型之间做转换：读文档把磁盘输入变成 `SourceDocument`，切块把它变成 `ChunkRecord`，embedding 把它变成 `VectorStoreRecord`，检索再把它变成 `SearchHit`。这条线越清楚，RAG 系统越不容易变成一团脚本。

## 相对起点的变更

| 组件 | 之前 | 之后 (B01) |
| --- | --- | --- |
| 项目 | （无） | `mini-rag` 空项目，`tsx` 直接跑 TS |
| 运行脚本 | （无） | `npm run dev` |
| 数据类型 | （无） | 5 个核心 interface（`types.ts`） |
| 模型接入 | （无，本章不做） | 留到 B02 |

## 试一试

```bash
npm run dev
```

初始化项目后试试：

1. 跑通空壳，确认输出 `hello.md: 27 字符`。
2. 故意把 `main.ts` 里 `doc` 的 `source` 字段删掉，看 TypeScript 是否报错——这就是用类型钉住字段的价值。
3. 在 `types.ts` 里给 `ChunkRecord` 加一个字段，观察后面哪些类型会跟着受影响。

## 本章小结

- `mini-rag` 是从零手写的简化 RAG，主链路和 tiny-rag 一致。
- 本章只做两件事：**初始化项目**（`tsx` 直接跑 TypeScript）和**定义 5 个核心类型**。
- 记住数据主线：`SourceDocument → ChunkRecord → VectorStoreRecord`（导入），`ChunkRecord → SearchHit → ChatMessage`（查询）。
- 先定类型再写逻辑，好处是每一步都能单独测试，不必一次跑通整条链路。

:::note[下一章：B02 模型抽象与 Provider]
有了类型，下一章把 RAG 需要的两种模型能力——embedding 和 chat——抽象成两个可替换的函数，让后面的导入、检索、问答都只依赖函数签名，不绑定具体厂商。
:::
