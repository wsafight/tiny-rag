// test/providers.test.ts
// -----------------------------------------------------------------------------
// 覆盖 provider client 的请求构造、响应解析、流式输出和运行时参数校验。
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chat,
  embed,
  resolveProviderRuntimeOptions,
} from '../src/providers/index';
import type { EmbeddingConfig, LLMConfig } from '../src/types';

const openAIEmbeddingConfig: EmbeddingConfig = {
  provider: 'openai',
  baseURL: 'http://provider.test/v1',
  apiKey: 'secret',
  model: 'embedding-model',
};

const openAIChatConfig: LLMConfig = {
  provider: 'openai',
  baseURL: 'http://provider.test/v1',
  apiKey: 'secret',
  model: 'chat-model',
};

const ollamaEmbeddingConfig: EmbeddingConfig = {
  provider: 'ollama',
  baseURL: 'http://ollama.test',
  apiKey: '',
  model: 'nomic-embed-text',
};

const ollamaChatConfig: LLMConfig = {
  provider: 'ollama',
  baseURL: 'http://ollama.test',
  apiKey: '',
  model: 'qwen2.5:7b',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('embed: OpenAI compatible 请求 /embeddings 并按 index 排序', async (t) => {
  const calls: Array<{ url: string; body: unknown; authorization?: string }> = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      return jsonResponse({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    },
  );

  const vectors = await embed(['first', 'second'], openAIEmbeddingConfig, {
    requestRetries: 0,
  });

  assert.deepEqual(vectors, [
    [1, 0],
    [0, 1],
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://provider.test/v1/embeddings');
  assert.equal(calls[0].authorization, 'Bearer secret');
  assert.deepEqual(calls[0].body, {
    model: 'embedding-model',
    input: ['first', 'second'],
  });
});

test('embed: OpenAI compatible 4xx 响应直接透出状态和正文', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    calls += 1;
    return new Response('bad key', { status: 401 });
  });

  await assert.rejects(
    () => embed(['x'], openAIEmbeddingConfig, { requestRetries: 2 }),
    /Embedding 请求失败: 401 bad key/,
  );
  assert.equal(calls, 1);
});

test('embed: 校验 provider 返回数量、维度和数值合法性', async (t) => {
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> =>
    jsonResponse({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1, 2] },
      ],
    }),
  );

  await assert.rejects(
    () => embed(['a', 'b'], openAIEmbeddingConfig, { requestRetries: 0 }),
    /第 2 条 embedding 非法或维度不一致/,
  );
});

test('chat: OpenAI compatible 非流式响应解析 message.content', async (t) => {
  let requestBody: unknown;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.equal(String(input), 'http://provider.test/v1/chat/completions');
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [{ message: { content: 'answer text' } }],
      });
    },
  );

  const answer = await chat(
    [{ role: 'user', content: 'question' }],
    openAIChatConfig,
    {},
    { llmTemperature: 0.4, requestRetries: 0 },
  );

  assert.equal(answer, 'answer text');
  assert.deepEqual(requestBody, {
    model: 'chat-model',
    messages: [{ role: 'user', content: 'question' }],
    temperature: 0.4,
    stream: false,
  });
});

test('chat: OpenAI compatible 流式响应聚合 token 并调用 onToken', async (t) => {
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"A"}}]}',
        'data: {"choices":[{"delta":{"content":"B"}}]}',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200 },
    );
  });

  const tokens: string[] = [];
  const answer = await chat(
    [{ role: 'user', content: 'question' }],
    openAIChatConfig,
    { onToken: (token) => tokens.push(token) },
    { requestRetries: 0 },
  );

  assert.equal(answer, 'AB');
  assert.deepEqual(tokens, ['A', 'B']);
});

test('embed: Ollama 对每个输入调用 /api/embeddings 并保持顺序', async (t) => {
  const prompts: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.equal(String(input), 'http://ollama.test/api/embeddings');
      const body = JSON.parse(String(init?.body)) as { prompt: string; model: string };
      prompts.push(body.prompt);
      assert.equal(body.model, 'nomic-embed-text');
      return jsonResponse({
        embedding: body.prompt === 'first' ? [1, 0] : [0, 1],
      });
    },
  );

  const vectors = await embed(['first', 'second'], ollamaEmbeddingConfig, {
    requestRetries: 0,
    ollamaEmbedConcurrency: 1,
  });

  assert.deepEqual(prompts, ['first', 'second']);
  assert.deepEqual(vectors, [
    [1, 0],
    [0, 1],
  ]);
});

test('chat: Ollama 支持非流式和流式响应', async (t) => {
  let streamMode = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { stream: boolean };
      streamMode = body.stream;
      if (!body.stream) {
        return jsonResponse({ message: { content: 'plain answer' } });
      }
      return new Response(
        [
          JSON.stringify({ message: { content: '流' } }),
          JSON.stringify({ message: { content: '式' } }),
          '',
        ].join('\n'),
      );
    },
  );

  assert.equal(
    await chat([{ role: 'user', content: 'q' }], ollamaChatConfig, {}, { requestRetries: 0 }),
    'plain answer',
  );
  assert.equal(streamMode, false);

  const tokens: string[] = [];
  const streamed = await chat(
    [{ role: 'user', content: 'q' }],
    ollamaChatConfig,
    { onToken: (token) => tokens.push(token) },
    { requestRetries: 0 },
  );
  assert.equal(streamed, '流式');
  assert.deepEqual(tokens, ['流', '式']);
  assert.equal(streamMode, true);
});

test('resolveProviderRuntimeOptions: 合并默认值并校验范围', () => {
  assert.deepEqual(resolveProviderRuntimeOptions({ requestRetries: 0 }), {
    requestTimeoutMs: 60_000,
    requestRetries: 0,
    ollamaEmbedConcurrency: 4,
    llmTemperature: 0.2,
  });
  assert.throws(
    () => resolveProviderRuntimeOptions({ requestTimeoutMs: 0 }),
    /requestTimeoutMs/,
  );
  assert.throws(
    () => resolveProviderRuntimeOptions({ requestRetries: -1 }),
    /requestRetries/,
  );
  assert.throws(
    () => resolveProviderRuntimeOptions({ ollamaEmbedConcurrency: 0 }),
    /ollamaEmbedConcurrency/,
  );
  assert.throws(
    () => resolveProviderRuntimeOptions({ llmTemperature: 3 }),
    /llmTemperature/,
  );
});

