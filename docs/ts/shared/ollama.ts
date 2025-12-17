/**
 * shared/ollama.ts
 *
 * Ollama API types, NDJSON parsing, and base streaming utilities.
 */
import type { Operation, Stream, Subscription } from 'effection';
import { resource, call, ensure } from 'effection';

// --- Configuration ---

export const OLLAMA_API_URL = 'http://localhost:11434/api/chat';
export const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:30b';

// --- Token Usage ---

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// --- Message Types ---

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

// --- Request/Response Types ---

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  format?: Record<string, unknown>; // JSON Schema for structured output
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatChunk {
  message: {
    role: string;
    content: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

// --- NDJSON Parser ---

/**
 * Parse a ReadableStream of NDJSON (newline-delimited JSON) into a Stream.
 * Handles buffering, cleanup, and graceful cancellation.
 */
export function parseNDJSON<T>(readable: ReadableStream<Uint8Array>): Stream<T, void> {
  return resource(function* (provide) {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    yield* ensure(function* () {
      yield* call(() => reader.cancel());
    });

    yield* provide({
      *next(): Operation<IteratorResult<T, void>> {
        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
              return { done: false, value: JSON.parse(line) as T };
            }
            continue;
          }

          const { done, value } = yield* call(() => reader.read());
          if (done) {
            const remaining = buffer.trim();
            if (remaining) {
              buffer = '';
              return { done: false, value: JSON.parse(remaining) as T };
            }
            return { done: true, value: undefined };
          }
          buffer += decoder.decode(value, { stream: true });
        }
      },
    });
  });
}

// --- Stream Consumption Helper ---

/**
 * Consume a stream with an async handler, returning the stream's TReturn.
 */
export function* consumeStream<T, R>(
  stream: Stream<T, R>,
  handler: (value: T) => Operation<void>
): Operation<R> {
  const subscription: Subscription<T, R> = yield* stream;
  let next = yield* subscription.next();

  while (!next.done) {
    yield* handler(next.value);
    next = yield* subscription.next();
  }

  return next.value;
}

// --- Usage Helpers ---

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function usageFromChunk(chunk: OllamaChatChunk): TokenUsage {
  return {
    promptTokens: chunk.prompt_eval_count ?? 0,
    completionTokens: chunk.eval_count ?? 0,
    totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
  };
}
