/**
 * streaming-chat-ollama.ts
 *
 * Streaming chat using raw fetch to Ollama's native API.
 * No AI SDK dependencies - just fetch + Effection.
 *
 * Demonstrates:
 * - NDJSON stream parsing with Effection
 * - useAbortSignal for proper cancellation
 * - Token usage tracking from Ollama's native response format
 */
import type { Operation, Stream, Subscription, Context } from 'effection';
import {
  main,
  resource,
  call,
  useAbortSignal,
  ensure,
  createContext,
} from 'effection';
import * as readline from 'node:readline/promises';

// --- Ollama API Types ---

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: true;
}

interface OllamaChatChunk {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  // Token counts only present in final chunk (done: true)
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

// --- Constants ---

const OLLAMA_API_URL = 'http://localhost:11434/api/chat';

const MODEL_CONTEXT_LIMITS: Map<string, number> = new Map([
  ['gemma3:4b', 128_000],
  ['gemma3:12b', 128_000],
  ['gemma3:27b', 128_000],
  ['gemma2:2b', 8_192],
  ['gemma2', 8_192],
  ['gemma2:9b', 8_192],
  ['gemma2:27b', 8_192],
  ['llama3.2', 128_000],
  ['llama3.2:1b', 128_000],
  ['llama3.2:3b', 128_000],
  ['llama3.1', 128_000],
  ['llama3.1:8b', 128_000],
  ['llama3.1:70b', 128_000],
  ['mistral', 32_000],
  ['mixtral', 32_000],
  ['qwen2.5', 128_000],
  ['phi3', 128_000],
  ['deepseek-r1', 64_000],
]);

const DEFAULT_CONTEXT_LIMIT = 8_192;
const MODEL_NAME = 'gemma3:27b';

function getContextLimit(modelName: string): number {
  return MODEL_CONTEXT_LIMITS.get(modelName) ?? DEFAULT_CONTEXT_LIMIT;
}

// --- Token Usage Types ---

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface StreamResult {
  text: string;
  usage: TokenUsage;
}

interface UsageState {
  current: TokenUsage;
  cumulative: TokenUsage;
  contextLimit: number;
  history: TokenUsage[];
}

const UsageContext: Context<UsageState> = createContext<UsageState>('usage');

// --- NDJSON Stream Parser ---

/**
 * Parse a ReadableStream of NDJSON into an Effection Stream of objects.
 * Handles partial lines across chunk boundaries.
 */
function parseNDJSON<T>(
  readable: ReadableStream<Uint8Array>
): Stream<T, void> {
  return resource(function*(provide) {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    yield* ensure(function*() {
      yield* call(() => reader.cancel());
    });

    yield* provide({
      *next(): Operation<IteratorResult<T, void>> {
        while (true) {
          // Try to extract a complete line from buffer
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line) {
              const parsed = JSON.parse(line) as T;
              return { done: false, value: parsed };
            }
            continue; // Empty line, try next
          }

          // Need more data
          const { done, value } = yield* call(() => reader.read());

          if (done) {
            // Process any remaining buffer content
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

// --- Stream Consumption Helper ---

/**
 * Consume a stream with an async handler, returning the stream's TReturn.
 */
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

// --- Text Stream Resource ---

/**
 * Stream text chunks from Ollama's native /api/chat endpoint.
 * Returns the complete response and token usage as TReturn.
 */
function useTextStream(messages: OllamaMessage[]): Stream<string, StreamResult> {
  return resource(function*(provide) {
    const signal = yield* useAbortSignal();

    const request: OllamaChatRequest = {
      model: MODEL_NAME,
      messages,
      stream: true,
    };

    const response = yield* call(() =>
      fetch(OLLAMA_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      })
    );

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body from Ollama');
    }

    const chunkStream = parseNDJSON<OllamaChatChunk>(response.body);
    const subscription: Subscription<OllamaChatChunk, void> = yield* chunkStream;

    let buffer = '';
    let finalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    yield* provide({
      *next(): Operation<IteratorResult<string, StreamResult>> {
        const next = yield* subscription.next();

        if (next.done) {
          return {
            done: true,
            value: { text: buffer, usage: finalUsage },
          };
        }

        const chunk = next.value;

        // Check for API errors in the chunk
        if (chunk.error) {
          throw new Error(`Ollama error: ${chunk.error}`);
        }

        // Accumulate content
        const content = chunk.message?.content ?? '';
        buffer += content;

        // Capture token counts from final chunk
        if (chunk.done) {
          finalUsage = {
            promptTokens: chunk.prompt_eval_count ?? 0,
            completionTokens: chunk.eval_count ?? 0,
            totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
          };
          // Return the last content chunk (may be empty)
          if (content) {
            return { done: false, value: content };
          }
          // Signal stream end
          return {
            done: true,
            value: { text: buffer, usage: finalUsage },
          };
        }

        return { done: false, value: content };
      },
    });
  });
}

// --- Main Chat Loop ---

const terminal = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages: OllamaMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
];

await main(function*() {
  yield* ensure(() => terminal.close());

  yield* UsageContext.set({
    current: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cumulative: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    contextLimit: getContextLimit(MODEL_NAME),
    history: [],
  });

  console.log('Chat with AI (type "exit" to quit)\n');

  while (true) {
    let userInput: string;
    try {
      userInput = yield* call(() => terminal.question('You: '));
    } catch {
      console.log('\nGoodbye!');
      break;
    }

    if (userInput.toLowerCase() === 'exit') {
      console.log('Goodbye!');
      break;
    }

    if (!userInput.trim()) {
      continue;
    }

    messages.push({ role: 'user', content: userInput });

    try {
      process.stdout.write('Assistant: ');

      const { text: fullResponse, usage } = yield* consumeAsync(
        useTextStream(messages),
        function*(chunk) {
          yield* call(() => {
            process.stdout.write(chunk);
          });
        }
      );

      process.stdout.write('\n\n');

      // Update usage context
      const prevState = yield* UsageContext.expect();
      const newState: UsageState = {
        current: usage,
        cumulative: {
          promptTokens: prevState.cumulative.promptTokens + usage.promptTokens,
          completionTokens: prevState.cumulative.completionTokens + usage.completionTokens,
          totalTokens: prevState.cumulative.totalTokens + usage.totalTokens,
        },
        contextLimit: prevState.contextLimit,
        history: [...prevState.history, usage],
      };
      yield* UsageContext.set(newState);

      const percentUsed = (
        (newState.cumulative.totalTokens / newState.contextLimit) * 100
      ).toFixed(2);
      console.log(
        `[tokens: +${usage.totalTokens} | total: ${newState.cumulative.totalTokens.toLocaleString()} / ${newState.contextLimit.toLocaleString()} (${percentUsed}%)]`
      );
      console.log('');

      messages.push({ role: 'assistant', content: fullResponse });
    } catch (error) {
      console.error('\n\nError:', error instanceof Error ? error.message : error);
      console.log('Please try again.\n');

      // Remove the failed user message
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'user') {
        messages.pop();
      }
    }
  }
});
