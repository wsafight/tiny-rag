export type LLMProvider = 'lmstudio' | 'ollama' | 'openai' | 'deepseek';
export type EmbeddingProvider = 'lmstudio' | 'ollama' | 'openai';

export interface ModelConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LLMConfig extends ModelConfig {
  provider: LLMProvider;
}

export interface EmbeddingConfig extends ModelConfig {
  provider: EmbeddingProvider;
}

export type EmbedFunction = (inputs: readonly string[]) => Promise<number[][]>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

export interface ChatOptions {
  onToken?: (token: string) => void;
}

export type ChatFunction = (
  messages: readonly ChatMessage[],
  options?: ChatOptions,
) => Promise<string>;
