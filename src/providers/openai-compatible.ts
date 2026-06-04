import { fetchWithRetry, readLines } from './http';
import { fail, isRecord, tryParseJson } from '../utils/index';
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

function readOpenAIEmbeddingResponse(value: unknown): OpenAIEmbeddingResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    fail('embedding response is missing the data array');
  }
  return {
    data: value.data.map((item, index) => {
      if (!isRecord(item) || !('embedding' in item)) {
        fail(`embedding response item #${index + 1} is missing the embedding field`);
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
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    fail('chat response is missing the choices array');
  }
  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    fail('chat response is missing choices[0].message');
  }
  const content = firstChoice.message.content;
  if (typeof content !== 'string') {
    fail('chat response is missing choices[0].message.content');
  }
  return { content };
}

function tryReadOpenAIStreamChunk(line: string): OpenAIStreamChunk | undefined {
  const value = tryParseJson(line);
  return isRecord(value) ? (value as OpenAIStreamChunk) : undefined;
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
    fail(`embedding request failed: ${response.status} ${text}`);
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
    fail(`chat request failed: ${response.status} ${text}`);
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
