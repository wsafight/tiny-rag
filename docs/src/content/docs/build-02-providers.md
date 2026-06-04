---
title: "B02: 模型抽象与 Provider"
description: 定义 embed/chat 两个模型能力，并用 OpenAI 兼容接口接入本地或远程模型服务。
---

上一章只定义了数据形态，还没有真正接模型。RAG 需要两类模型能力：embedding 负责把文本变成向量，chat 负责根据 Prompt 生成回答。这一章先把这两个能力抽象出来。

## 先理解：embedding 和 chat 要分开

embedding 模型和聊天模型不是一回事。

- **embedding**：输入文本数组，输出向量数组。向量会写进向量库，换模型后必须重新导入。
- **chat**：输入消息列表，输出一段回答。换聊天模型通常不影响已经写好的向量库。

代码里把它们定义成函数类型，后面的导入、检索和问答逻辑只依赖函数，不关心背后是 LM Studio、Ollama、OpenAI 还是别的服务。

DeepSeek 在 tiny-rag 里只作为 chat provider 使用，embedding 仍要选择支持 `/embeddings` 的服务。

## 定义函数类型

新建 `providers.ts`，先只写类型：

```ts
// providers.ts
import type { ChatMessage } from './types';

export type EmbedFunction = (inputs: readonly string[]) => Promise<number[][]>;

export type ChatFunction = (messages: readonly ChatMessage[]) => Promise<string>;
```

`EmbedFunction` 接收数组，是因为很多 embedding 服务支持批量请求。即使你一次只嵌入一个问题，也保持同一个接口，后面导入 chunk 时就能直接批量使用。

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
