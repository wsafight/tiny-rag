import { fail } from '../utils/index';

export interface RetryOptions {
  requestTimeoutMs: number;
  requestRetries: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  options: RetryOptions,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= options.requestRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (response.status >= 400 && response.status < 500) return response;
      if (!response.ok) {
        lastErr = new Error(`${label} HTTP ${response.status}`);
      } else {
        return response;
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
    if (attempt < options.requestRetries) {
      await sleep(500 * 2 ** attempt);
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  return fail(`${label} request failed`);
}

export async function readLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) {
    fail('streaming response is missing a body');
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) onLine(line);
      }
    }
    buffer += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const tail = buffer.trim();
  if (tail) onLine(tail);
}
