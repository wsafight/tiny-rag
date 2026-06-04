import { fetchWithRetry, readLines } from './http';
import { fail } from '../utils/index';
import type { ChatMessage, ChatOptions, ModelConfig } from './types';
import type { ResolvedProviderRuntimeOptions } from './runtime';

export type OpenAICompatibleConfig = Pick<ModelConfig, 'baseURL' | 'apiKey' | 'model'>;

interface OpenAIEmbeddingItem {
  index?: number;
  embedding: unknown;
}

interface OpenAIEmbeddingResponse {
  data: OpenAIEmbeddingItem[];
}

interface OpenAIChatResponse {
  content: string;
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOpenAIEmbeddingResponse(value: unknown): OpenAIEmbeddingResponse {
  if (!isObject(value) || !Array.isArray(value.data)) {
    fail('Embedding 返回缺少 data 数组');
  }
  return {
    data: value.data.map((item, index) => {
      if (!isObject(item) || !('embedding' in item)) {
        fail(`Embedding 返回的第 ${index + 1} 条缺少 embedding 字段`);
      }
      const rawIndex = item.index;
      return {
        index: typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? rawIndex : undefined,
        embedding: item.embedding,
      };
    }),
  };
}

function readOpenAIChatResponse(value: unknown): OpenAIChatResponse {
  if (!isObject(value) || !Array.isArray(value.choices)) {
    fail('Chat 返回缺少 choices 数组');
  }
  const firstChoice = value.choices[0];
  if (!isObject(firstChoice) || !isObject(firstChoice.message)) {
    fail('Chat 返回缺少 choices[0].message');
  }
  const content = firstChoice.message.content;
  if (typeof content !== 'string') {
    fail('Chat 返回缺少 choices[0].message.content');
  }
  return { content };
}

function tryReadOpenAIStreamChunk(line: string): OpenAIStreamChunk | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isObject(value) ? (value as OpenAIStreamChunk) : undefined;
  } catch {
    return undefined;
  }
}

export async function embedOpenAICompatible(
  config: OpenAICompatibleConfig,
  inputs: readonly string[],
  options: ResolvedProviderRuntimeOptions,
): Promise<unknown[]> {
  const response = await fetchWithRetry(
    `${config.baseURL}/embeddings`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || 'sk-none'}`,
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
    },
    'Embedding',
    options,
  );
  if (!response.ok) {
    const text = await response.text();
    fail(`Embedding 请求失败: ${response.status} ${text}`);
  }
  const data = readOpenAIEmbeddingResponse(await response.json());
  return data.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding);
}

export async function chatOpenAICompatible(
  config: OpenAICompatibleConfig,
  messages: readonly ChatMessage[],
  opts: ChatOptions = {},
  options: ResolvedProviderRuntimeOptions,
): Promise<string> {
  const stream = typeof opts.onToken === 'function';
  const response = await fetchWithRetry(
    `${config.baseURL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || 'sk-none'}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.llmTemperature,
        stream,
      }),
    },
    'Chat',
    options,
  );
  if (!response.ok) {
    const text = await response.text();
    fail(`Chat 请求失败: ${response.status} ${text}`);
  }

  if (!stream) {
    return readOpenAIChatResponse(await response.json()).content;
  }

  let full = '';
  await readLines(response.body, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const json = tryReadOpenAIStreamChunk(payload);
    const token = json?.choices?.[0]?.delta?.content ?? '';
    if (token) {
      full += token;
      opts.onToken?.(token);
    }
  });
  return full;
}
