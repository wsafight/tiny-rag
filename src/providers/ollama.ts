import { fetchWithRetry, readLines } from './http';
import { fail, isRecord, runWithConcurrency, tryParseJson } from '../utils/index';
import type { ChatMessage, ChatOptions, ModelConfig } from './types';
import type { ResolvedProviderRuntimeOptions } from './runtime';

export type OllamaConfig = Pick<ModelConfig, 'baseURL' | 'model'>;

interface OllamaEmbeddingResponse {
  embedding: unknown;
}

interface OllamaChatResponse {
  content: string;
}

interface OllamaStreamChunk {
  message?: {
    content?: string;
  };
}

function readOllamaEmbeddingResponse(value: unknown): OllamaEmbeddingResponse {
  if (!isRecord(value) || !('embedding' in value)) {
    fail('Ollama embedding response is missing the embedding field');
  }
  return { embedding: value.embedding };
}

function readOllamaChatResponse(value: unknown): OllamaChatResponse {
  if (!isRecord(value) || !isRecord(value.message)) {
    fail('Ollama chat response is missing the message object');
  }
  const content = value.message.content;
  if (typeof content !== 'string') {
    fail('Ollama chat response is missing message.content');
  }
  return { content };
}

function tryReadOllamaStreamChunk(line: string): OllamaStreamChunk | undefined {
  const value = tryParseJson(line);
  return isRecord(value) ? (value as OllamaStreamChunk) : undefined;
}

export async function embedOllama(
  config: OllamaConfig,
  inputs: readonly string[],
  options: ResolvedProviderRuntimeOptions,
): Promise<unknown[]> {
  const tasks = inputs.map((text) => async () => {
    const response = await fetchWithRetry(
      `${config.baseURL}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: text }),
      },
      'Ollama embedding',
      options,
    );
    if (!response.ok) {
      const errText = await response.text();
      fail(`Ollama embedding request failed: ${response.status} ${errText}`);
    }
    return readOllamaEmbeddingResponse(await response.json()).embedding;
  });
  return runWithConcurrency(tasks, options.ollamaEmbedConcurrency);
}

export async function chatOllama(
  config: OllamaConfig,
  messages: readonly ChatMessage[],
  opts: ChatOptions = {},
  options: ResolvedProviderRuntimeOptions,
): Promise<string> {
  const stream = typeof opts.onToken === 'function';
  const response = await fetchWithRetry(
    `${config.baseURL}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream,
        options: { temperature: options.llmTemperature },
      }),
    },
    'Ollama chat',
    options,
  );
  if (!response.ok) {
    const text = await response.text();
    fail(`Ollama chat request failed: ${response.status} ${text}`);
  }

  if (!stream) {
    return readOllamaChatResponse(await response.json()).content;
  }

  let full = '';
  await readLines(response.body, (line) => {
    const json = tryReadOllamaStreamChunk(line);
    const token = json?.message?.content ?? '';
    if (token) {
      full += token;
      opts.onToken?.(token);
    }
  });
  return full;
}
