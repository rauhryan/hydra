/**
 * tool-calling.ts
 *
 * Native Effection tool calling with Ollama.
 * Demonstrates:
 * - Zod-based tool definitions with JSON Schema generation
 * - Event-based streaming with Stream<ChatEvent, ChatResult>
 * - Result type for error-as-value pattern
 * - Parallel tool execution with all()
 * - Cumulative token usage tracking with Context
 * - User-controlled chat loop
 */
import type { Operation, Stream, Subscription, Context, Task } from 'effection';
import {
  main,
  resource,
  call,
  all,
  useAbortSignal,
  ensure,
  createContext,
  spawn,
  each,
  interval,
} from 'effection';
import { z } from 'zod';
import * as readline from 'node:readline/promises';

// --- Result Type ---

type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// --- Token Usage Types ---

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface UsageState {
  current: TokenUsage;
  cumulative: TokenUsage;
  contextLimit: number;
  history: TokenUsage[];
}

const UsageContext: Context<UsageState> = createContext<UsageState>('usage');

// --- Model Context Limits ---

const MODEL_CONTEXT_LIMITS: Map<string, number> = new Map([
  ['gemma3:4b', 128_000],
  ['gemma3:12b', 128_000],
  ['gemma3:27b', 128_000],
  ['llama3.2', 128_000],
  ['llama3.1', 128_000],
  ['mistral', 32_000],
  ['mixtral', 32_000],
  ['qwen2.5', 128_000],
  ['qwen3:30b', 128_000],
  ['qwen3:8b', 128_000],
  ['phi3', 128_000],
  ['deepseek-r1', 64_000],
]);

const DEFAULT_CONTEXT_LIMIT = 8_192;

function getContextLimit(modelName: string): number {
  return MODEL_CONTEXT_LIMITS.get(modelName) ?? DEFAULT_CONTEXT_LIMIT;
}

// --- Tool Definition ---

interface ToolDef<TParams extends z.ZodType, TReturn> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>) => Operation<TReturn>;
}

function defineTool<TParams extends z.ZodType, TReturn>(
  def: ToolDef<TParams, TReturn>
): ToolDef<TParams, TReturn> {
  return def;
}

// --- Tool Registry ---

type AnyTool = ToolDef<z.ZodType, unknown>;

interface ToolRegistry {
  tools: Map<string, AnyTool>;
  toOllamaFormat(): OllamaTool[];
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function createToolRegistry(tools: AnyTool[]): ToolRegistry {
  const map = new Map<string, AnyTool>();
  for (const tool of tools) {
    map.set(tool.name, tool);
  }

  return {
    tools: map,
    toOllamaFormat(): OllamaTool[] {
      return tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters),
        },
      }));
    },
  };
}

// --- Tool Execution ---

// Ollama returns arguments as object (not JSON string like OpenAI)
interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface ToolResult {
  id: string;
  content: string;
  ok: boolean;
}

interface ToolError {
  callId: string;
  toolName: string;
  message: string;
  cause?: unknown;
  phase: 'validation' | 'execution' | 'not_found';
}

function* executeToolCall(
  registry: ToolRegistry,
  toolCall: ToolCall
): Operation<Result<ToolResult, ToolError>> {
  const { id, function: fn } = toolCall;
  const tool = registry.tools.get(fn.name);

  if (!tool) {
    return err({
      callId: id,
      toolName: fn.name,
      message: `Unknown tool: ${fn.name}`,
      phase: 'not_found',
    });
  }

  // Validate arguments (Ollama already parsed them)
  const parsed = tool.parameters.safeParse(fn.arguments);
  if (!parsed.success) {
    return err({
      callId: id,
      toolName: fn.name,
      message: `Validation failed: ${parsed.error.message}`,
      cause: parsed.error,
      phase: 'validation',
    });
  }

  // Execute the tool
  try {
    const result = yield* tool.execute(parsed.data);
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    return ok({ id, content, ok: true });
  } catch (e) {
    return err({
      callId: id,
      toolName: fn.name,
      message: e instanceof Error ? e.message : String(e),
      cause: e,
      phase: 'execution',
    });
  }
}

// --- Ollama API Types ---

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: boolean;
}

interface OllamaChatChunk {
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

// --- Chat Stream Types ---

type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] };

interface ChatResult {
  text: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
}

// --- NDJSON Parser ---

function parseNDJSON<T>(readable: ReadableStream<Uint8Array>): Stream<T, void> {
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

// --- Chat Stream ---

const OLLAMA_API_URL = 'http://localhost:11434/api/chat';
const MODEL_NAME = process.env.OLLAMA_MODEL ?? 'qwen3:30b';

/**
 * Stream chat events from Ollama.
 * Yields ChatEvent for each chunk, returns ChatResult with full response.
 */
function useChatStream(
  messages: OllamaMessage[],
  options?: { tools?: ToolRegistry }
): Stream<ChatEvent, ChatResult> {
  return resource(function*(provide) {
    const signal = yield* useAbortSignal();

    const request: OllamaChatRequest = {
      model: MODEL_NAME,
      messages,
      stream: true,
      ...(options?.tools && { tools: options.tools.toOllamaFormat() }),
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
      throw new Error(`Ollama API error: ${response.status}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }

    const chunkStream = parseNDJSON<OllamaChatChunk>(response.body);
    const subscription: Subscription<OllamaChatChunk, void> = yield* chunkStream;

    // Accumulators
    let textBuffer = '';
    let thinkingBuffer = '';
    let toolCalls: ToolCall[] = [];
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Queue of events to yield
    const pendingEvents: ChatEvent[] = [];

    yield* provide({
      *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
        // Yield any pending events first
        if (pendingEvents.length > 0) {
          return { done: false, value: pendingEvents.shift()! };
        }

        // Read next chunk from Ollama
        const next = yield* subscription.next();

        if (next.done) {
          // Stream finished, return final result
          return {
            done: true,
            value: {
              text: textBuffer,
              thinking: thinkingBuffer || undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              usage,
            },
          };
        }

        const chunk = next.value;

        if (chunk.error) {
          throw new Error(`Ollama: ${chunk.error}`);
        }

        // Capture usage from final chunk
        if (chunk.done) {
          usage = {
            promptTokens: chunk.prompt_eval_count ?? 0,
            completionTokens: chunk.eval_count ?? 0,
            totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
          };
        }

        // Accumulate and emit text
        if (chunk.message.content) {
          textBuffer += chunk.message.content;
          pendingEvents.push({ type: 'text', content: chunk.message.content });
        }

        // Accumulate and emit thinking
        if (chunk.message.thinking) {
          thinkingBuffer += chunk.message.thinking;
          pendingEvents.push({ type: 'thinking', content: chunk.message.thinking });
        }

        // Accumulate and emit tool calls
        if (chunk.message.tool_calls) {
          toolCalls = [...toolCalls, ...chunk.message.tool_calls];
          pendingEvents.push({ type: 'tool_calls', toolCalls: chunk.message.tool_calls });
        }

        // Return first pending event, or recurse to get next chunk
        if (pendingEvents.length > 0) {
          return { done: false, value: pendingEvents.shift()! };
        }

        // No events from this chunk, get next
        return yield* this.next();
      },
    });
  });
}

// --- Example Tools ---

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: z.object({
    location: z.string().describe('The city name, e.g. "San Francisco"'),
    unit: z.enum(['celsius', 'fahrenheit']).optional().describe('Temperature unit'),
  }),
  *execute({ location, unit }) {
    yield* call(() => new Promise((r) => setTimeout(r, 500)));
    const temp = Math.floor(Math.random() * 30) + 10;
    const conditions = ['sunny', 'cloudy', 'rainy', 'windy'];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    return {
      location,
      temperature: temp,
      unit: unit ?? 'celsius',
      condition,
    };
  },
});

const calculatorTool = defineTool({
  name: 'calculator',
  description: 'Perform basic arithmetic calculations',
  parameters: z.object({
    expression: z.string().describe('A mathematical expression, e.g. "2 + 2"'),
  }),
  *execute({ expression }) {
    try {
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        throw new Error('Invalid expression');
      }
      const result = Function(`"use strict"; return (${expression})`)();
      return { expression, result };
    } catch {
      throw new Error(`Could not evaluate: ${expression}`);
    }
  },
});

const searchTool = defineTool({
  name: 'search',
  description: 'Search for information on a topic',
  parameters: z.object({
    query: z.string().describe('The search query'),
  }),
  *execute({ query }) {
    yield* call(() => new Promise((r) => setTimeout(r, 300)));
    return {
      query,
      results: [
        { title: `Result 1 for "${query}"`, snippet: 'This is a simulated search result.' },
        { title: `Result 2 for "${query}"`, snippet: 'Another simulated result.' },
      ],
    };
  },
});

// --- Spinner Resource ---

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Spinner {
  start: (label?: string) => Operation<void>;
  stop: () => Operation<void>;
}

/**
 * Create a spinner resource that self-animates using interval().
 *
 * - start() spawns a background task that animates at 80ms intervals
 * - stop() halts the animation and clears the line
 * - Automatically cleans up on scope exit via ensure()
 *
 * Usage:
 *   const spinner = yield* useSpinner();
 *   yield* spinner.start('thinking');
 *   // ... spinner animates on its own ...
 *   yield* spinner.stop();
 */
function useSpinner(): Operation<Spinner> {
  return resource(function*(provide) {
    let animationTask: Task<void> | undefined;

    // Cleanup on scope exit (error, halt, or normal exit)
    yield* ensure(function*() {
      if (animationTask) {
        yield* animationTask.halt();
        process.stdout.write('\r' + ' '.repeat(20) + '\r');
      }
    });

    yield* provide({
      *start(label = 'thinking') {
        // Idempotent - if already running, do nothing
        if (animationTask) return;

        let frameIndex = 0;
        animationTask = yield* spawn(function*() {
          for (const _ of yield* each(interval(80))) {
            const frame = SPINNER_FRAMES[frameIndex++ % SPINNER_FRAMES.length];
            process.stdout.write(`\r${frame} ${label}...`);
            yield* each.next();
          }
        });
      },
      *stop() {
        if (animationTask) {
          yield* animationTask.halt();
          process.stdout.write('\r' + ' '.repeat(20) + '\r');
          animationTask = undefined;
        }
      },
    });
  });
}

/**
 * Run an operation with a spinner that animates for its duration.
 * Spinner automatically stops when operation completes or fails.
 */
function* withSpinner<T>(label: string, op: Operation<T>): Operation<T> {
  const spinner = yield* useSpinner();
  yield* spinner.start(label);
  try {
    return yield* op;
  } finally {
    yield* spinner.stop();
  }
}

// --- Main Chat Loop ---

const terminal = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const registry = createToolRegistry([weatherTool, calculatorTool, searchTool]);

const messages: OllamaMessage[] = [
  {
    role: 'system',
    content: `You are a helpful assistant with access to tools.
Use the tools when appropriate to answer user questions.
When the user asks about multiple things, call multiple tools in parallel.
Available tools: get_weather, calculator, search.`,
  },
];

await main(function*() {
  yield* ensure(() => terminal.close());

  // Initialize usage tracking
  yield* UsageContext.set({
    current: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cumulative: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    contextLimit: getContextLimit(MODEL_NAME),
    history: [],
  });

  console.log(`Tool-calling chat with ${MODEL_NAME} (type "exit" to quit)`);
  console.log('Available tools: get_weather, calculator, search\n');

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

    if (!userInput.trim()) continue;

    messages.push({ role: 'user', content: userInput });

    try {
      let iterations = 0;
      const maxIterations = 10;

      while (iterations < maxIterations) {
        iterations++;
        process.stdout.write('Assistant: ');

        const spinner = yield* useSpinner();

        const result = yield* consumeAsync(
          useChatStream(messages, { tools: registry }),
          function*(event) {
            if (event.type === 'text') {
              yield* spinner.stop();
              process.stdout.write(event.content);
            }

            if (event.type === 'thinking') {
              yield* spinner.start();
            }

            if (event.type === 'tool_calls') {
              yield* spinner.stop();
              console.log(`\n[Calling ${event.toolCalls.length} tool(s)...]`);
              for (const tc of event.toolCalls) {
                console.log(`  - ${tc.function.name}(${JSON.stringify(tc.function.arguments)})`);
              }
            }
          }
        );

        yield* spinner.stop();

        // Update usage context
        const prevState = yield* UsageContext.expect();
        const newState: UsageState = {
          current: result.usage,
          cumulative: {
            promptTokens: prevState.cumulative.promptTokens + result.usage.promptTokens,
            completionTokens: prevState.cumulative.completionTokens + result.usage.completionTokens,
            totalTokens: prevState.cumulative.totalTokens + result.usage.totalTokens,
          },
          contextLimit: prevState.contextLimit,
          history: [...prevState.history, result.usage],
        };
        yield* UsageContext.set(newState);

        if (result.toolCalls?.length) {
          // Execute tools in parallel
          const toolResults = yield* all(
            result.toolCalls.map((tc) => executeToolCall(registry, tc))
          );

          // Add assistant message with tool calls
          messages.push({
            role: 'assistant',
            content: result.text,
            tool_calls: result.toolCalls,
          });

          // Add tool results
          for (const toolResult of toolResults) {
            if (toolResult.ok) {
              console.log(`  [${toolResult.value.id}] OK: ${toolResult.value.content.slice(0, 80)}...`);
              messages.push({
                role: 'tool',
                tool_call_id: toolResult.value.id,
                content: toolResult.value.content,
              });
            } else {
              console.log(`  [${toolResult.error.callId}] ERROR: ${toolResult.error.message}`);
              messages.push({
                role: 'tool',
                tool_call_id: toolResult.error.callId,
                content: `Error: ${toolResult.error.message}`,
              });
            }
          }

          console.log('[Continuing...]\n');
        } else {
          // Text response - done with this turn
          process.stdout.write('\n');

          const percentUsed = (
            (newState.cumulative.totalTokens / newState.contextLimit) * 100
          ).toFixed(2);
          console.log(
            `[tokens: +${result.usage.totalTokens} | total: ${newState.cumulative.totalTokens.toLocaleString()} / ${newState.contextLimit.toLocaleString()} (${percentUsed}%)]`
          );
          console.log('');

          messages.push({ role: 'assistant', content: result.text });
          break;
        }
      }

      if (iterations >= maxIterations) {
        console.log('[Max tool iterations reached]\n');
      }
    } catch (error) {
      console.error('\n\nError:', error instanceof Error ? error.message : error);
      console.log('Please try again.\n');

      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'user') {
        messages.pop();
      }
    }
  }
});
