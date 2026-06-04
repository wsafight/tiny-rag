---
title: "B02: 模型抽象与 Provider"
description: 把 embedding 和 chat 拆成两个可替换函数，理解模型 provider 在 RAG 里的真实边界。
---

上一章只定义了数据形态，还没有真正接模型。RAG 需要两类模型能力：embedding 负责把文本变成向量，chat 负责根据 Prompt 生成回答。这一章先把这两个能力抽象出来。

很多 RAG demo 会把“调用模型”写在业务代码中间，看起来短，但后面很难换服务、加重试或测试失败场景。更稳的做法是先把模型能力缩成两个函数：一个负责向量化，一个负责生成文本。导入、检索和问答只依赖函数签名，不依赖具体厂商。

:::note[本章产出]
- **前置**：读完 `B01`，理解 embedding 与 chat 的区别。手边有一个可用的模型服务（本地 [LM Studio](https://lmstudio.ai/) / [Ollama](https://ollama.com/)，或任意 OpenAI 兼容接口）。
- **产出**：一份 `providers.ts`，导出 `createEmbedder()` 和 `createChat()` 两个工厂函数，并能用 `npm run dev` 验证模型真的能连通。
- **本章不做**：不读磁盘文档（下一章才做），先用写死的字符串验证模型连接。
:::

## 先理解：embedding 和 chat 要分开

embedding 模型和聊天模型不是一回事。

- **embedding**：输入文本数组，输出向量数组。向量会写进向量库，换模型后必须重新导入。
- **chat**：输入消息列表，输出一段回答。换聊天模型通常不影响已经写好的向量库。

代码里把它们定义成函数类型，后面的导入、检索和问答逻辑只依赖函数，不关心背后是 LM Studio、Ollama、OpenAI 还是别的服务。

:::tip[DeepSeek 只能当 chat，不能当 embedding]
不是所有模型服务都同时提供两种能力。比如 DeepSeek 在 tiny-rag 里只作为 **chat provider** 使用，它的 embedding 仍要另选一个支持 `/embeddings` 接口的服务（如 LM Studio 或 Ollama 上的 embedding 模型）。选 provider 前先确认它支持你需要的那种能力。
:::

这个分离是 RAG 的核心约束之一。聊天模型可以今天用 Qwen、明天用 DeepSeek，向量库仍然有效；embedding 模型一变，旧向量就失去比较意义。也就是说，chat 是“回答能力”，embedding 是“索引坐标系”。索引坐标系不能随便换。

provider 层只应该处理模型调用细节：URL、鉴权、请求体、响应解析、错误提示。它不应该知道 chunk 怎么切，也不应该知道 Prompt 怎么写。这样后面接 LM Studio、Ollama、OpenAI 兼容服务时，只是在替换函数实现。

## 定义函数类型

新建 `providers.ts`，先只写类型：

```ts
// providers.ts
import type { ChatMessage } from './types';

export type EmbedFunction = (inputs: readonly string[]) => Promise<number[][]>;

export type ChatFunction = (messages: readonly ChatMessage[]) => Promise<string>;
```

`EmbedFunction` 接收数组，是因为很多 embedding 服务支持批量请求。即使你一次只嵌入一个问题，也保持同一个接口，后面导入 chunk 时就能直接批量使用。

这个小设计会影响导入性能。如果接口只接收单个字符串，后面批量 embedding 时就只能在调用方循环；把 batch 作为默认形态，provider 就有机会按模型服务的最佳批大小合并请求。

## 接入 OpenAI 兼容接口

LM Studio、OpenAI 以及很多本地网关都提供 OpenAI 兼容接口。这里直接用 Node 内置 `fetch`，不引入 SDK：

```ts
// providers.ts（续）
interface ProviderConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
}

export function createEmbedder(config: ProviderConfig): EmbedFunction {
  return async (inputs) => {
    const res = await fetch(`${config.baseURL}/embeddings`, {
      method: 'POST',
      headers: jsonHeaders(config.apiKey),
      body: JSON.stringify({ model: config.model, input: inputs }),
    });
    if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  };
}

export function createChat(config: ProviderConfig): ChatFunction {
  return async (messages) => {
    const res = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: jsonHeaders(config.apiKey),
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  };
}

function jsonHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}
```

这段代码刻意没有加入超时、重试和并发控制，是为了让 provider 边界清楚。真实 tiny-rag 会在运行时配置里补上 `REQUEST_TIMEOUT_MS`、`REQUEST_RETRIES` 和不同 provider 的并发限制。学习时先看最小闭环，工程化时再把保护加回来。

## 验证模型连接

更新 `main.ts`，确认 embedding 和 chat 都能正常工作：

```ts
// main.ts
import { createChat, createEmbedder } from './providers';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1';

const embed = createEmbedder({ baseURL, model: process.env.EMBED_MODEL ?? 'nomic-embed-text' });
const chat = createChat({ baseURL, model: process.env.CHAT_MODEL ?? 'qwen2.5-7b-instruct' });

const [vec] = await embed(['hello mini-rag']);
console.log(`embedding 维度: ${vec.length}`);

const answer = await chat([
  { role: 'user', content: '用一句话介绍 RAG。' },
]);
console.log(`回答: ${answer}`);
```

运行（假设本地 LM Studio 已加载模型）：

```bash
npm run dev
```

预期输出类似：

```text
embedding 维度: 768
回答: RAG 是一种先检索相关资料、再让大模型基于这些资料回答问题的方法。
```

模型能力已经接进来了。下一章开始填第一段真实数据：把磁盘上的文档读进内存。

到这里，`mini-rag` 已经具备两种外部能力：把文本投到向量空间，以及让聊天模型基于消息生成回答。后面所有章节都不会再直接碰 HTTP 模型接口，而是通过 `embed` 和 `chat` 两个函数使用它们。

## 本章小结

- RAG 的两种模型能力被抽象成两个函数类型：`EmbedFunction`（文本 → 向量）和 `ChatFunction`（消息 → 回答）。
- `createEmbedder()` / `createChat()` 用内置 `fetch` 接 OpenAI 兼容接口，不引入 SDK。
- `EmbedFunction` 接收**数组**而非单个字符串，是为了让导入时能批量请求、提升性能。
- provider 层只管模型调用细节（URL、鉴权、解析），不掺切块和 Prompt 逻辑，换厂商时只换实现。

:::note[下一章：B03 文档读取与 source]
模型能力就绪后，下一章接入第一段真实数据——把磁盘上的 `.md` / `.txt` 读成稳定的 `SourceDocument`，并解释为什么 `source` 字段的规范化会影响后面所有 chunk。
:::
