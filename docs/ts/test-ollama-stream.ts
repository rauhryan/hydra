/**
 * Quick test of raw Ollama streaming without interactive terminal
 */
import type { Operation, Stream, Subscription } from 'effection';
import { main, resource, call, useAbortSignal, ensure } from 'effection';

const OLLAMA_API_URL = 'http://localhost:11434/api/chat';
const MODEL_NAME = 'gemma3:27b';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatChunk {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface StreamResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

function parseNDJSON<T>(readable: ReadableStream<Uint8Array>): Stream<T, void> {
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
              const parsed = JSON.parse(line) as T;
              return { done: false, value: parsed };
            }
            continue;
          }

          const { done, value } = yield* call(() => reader.read());
          if (done) {
            const remaining = buffer.trim();
            if (remaining) {
              buffer = '';
              const parsed = JSON.parse(remaining) as T;
              return { done: false, value: parsed };
            }
            return { done: true, value: undefined };
          }
          buffer += decoder.decode(value, { stream: true });
        }
      },
    });
  });
}

function* consumeAsync<T, R>(
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

function useTextStream(messages: OllamaMessage[]): Stream<string, StreamResult> {
  return resource(function* (provide) {
    const signal = yield* useAbortSignal();

    const response = yield* call(() =>
      fetch(OLLAMA_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL_NAME, messages, stream: true }),
        signal,
      })
    );

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }

    const chunkStream = parseNDJSON<OllamaChatChunk>(response.body);
    const subscription: Subscription<OllamaChatChunk, void> = yield* chunkStream;

    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;

    yield* provide({
      *next(): Operation<IteratorResult<string, StreamResult>> {
        const next = yield* subscription.next();

        if (next.done) {
          return { done: true, value: { text: buffer, promptTokens, completionTokens } };
        }

        const chunk = next.value;
        if (chunk.error) {
          throw new Error(`Ollama: ${chunk.error}`);
        }

        const content = chunk.message?.content ?? '';
        buffer += content;

        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? 0;
          completionTokens = chunk.eval_count ?? 0;
          if (content) {
            return { done: false, value: content };
          }
          return { done: true, value: { text: buffer, promptTokens, completionTokens } };
        }

        return { done: false, value: content };
      },
    });
  });
}

await main(function* () {
  console.log('Testing Ollama streaming...\n');

  const messages: OllamaMessage[] = [
    { role: 'user', content: 'Say hello in exactly 5 words.' },
  ];

  process.stdout.write('Response: ');

  const result = yield* consumeAsync(useTextStream(messages), function* (chunk) {
    yield* call(() => {
      process.stdout.write(chunk);
    });
  });

  console.log('\n');
  console.log('Full text:', result.text);
  console.log('Prompt tokens:', result.promptTokens);
  console.log('Completion tokens:', result.completionTokens);
});
