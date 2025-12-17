/**
 * Test streaming tool calling with parallel execution
 */
import type { Operation, Stream, Subscription } from 'effection';
import { main, resource, call, all, useAbortSignal, ensure } from 'effection';
import { z } from 'zod';

// --- Result Type ---
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
function ok<T>(value: T): Result<T, never> { return { ok: true, value }; }
function err<E>(error: E): Result<never, E> { return { ok: false, error }; }

// --- Token Usage ---
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

type AnyTool = ToolDef<z.ZodType, unknown>;

interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ToolRegistry {
  tools: Map<string, AnyTool>;
  toOllamaFormat(): OllamaTool[];
}

function createToolRegistry(tools: AnyTool[]): ToolRegistry {
  const map = new Map<string, AnyTool>();
  for (const tool of tools) map.set(tool.name, tool);
  return {
    tools: map,
    toOllamaFormat: () => tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.parameters),
      },
    })),
  };
}

// --- Tool Execution ---
interface ToolCall { id: string; function: { name: string; arguments: Record<string, unknown> } }
interface ToolResult { id: string; content: string; ok: boolean }
interface ToolError { callId: string; toolName: string; message: string; phase: string }

function* executeToolCall(registry: ToolRegistry, toolCall: ToolCall): Operation<Result<ToolResult, ToolError>> {
  const { id, function: fn } = toolCall;
  const tool = registry.tools.get(fn.name);
  if (!tool) return err({ callId: id, toolName: fn.name, message: `Unknown tool: ${fn.name}`, phase: 'not_found' });

  const parsed = tool.parameters.safeParse(fn.arguments);
  if (!parsed.success) return err({ callId: id, toolName: fn.name, message: `Validation failed: ${parsed.error.message}`, phase: 'validation' });

  try {
    const result = yield* tool.execute(parsed.data);
    return ok({ id, content: typeof result === 'string' ? result : JSON.stringify(result), ok: true });
  } catch (e) {
    return err({ callId: id, toolName: fn.name, message: e instanceof Error ? e.message : String(e), phase: 'execution' });
  }
}

// --- Ollama Types ---
interface OllamaMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
interface OllamaChatChunk {
  message: { role: string; content: string; thinking?: string; tool_calls?: ToolCall[] };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

// --- Stream Types ---
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
  return resource(function* (provide) {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    yield* ensure(function* () { yield* call(() => reader.cancel()); });
    yield* provide({
      *next(): Operation<IteratorResult<T, void>> {
        while (true) {
          const idx = buffer.indexOf('\n');
          if (idx !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) return { done: false, value: JSON.parse(line) as T };
            continue;
          }
          const { done, value } = yield* call(() => reader.read());
          if (done) {
            const remaining = buffer.trim();
            if (remaining) { buffer = ''; return { done: false, value: JSON.parse(remaining) as T }; }
            return { done: true, value: undefined };
          }
          buffer += decoder.decode(value, { stream: true });
        }
      },
    });
  });
}

// --- Stream Consumption ---
function* consumeAsync<T, R>(stream: Stream<T, R>, handler: (value: T) => Operation<void>): Operation<R> {
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

function useChatStream(messages: OllamaMessage[], options?: { tools?: ToolRegistry }): Stream<ChatEvent, ChatResult> {
  return resource(function* (provide) {
    const signal = yield* useAbortSignal();
    const response = yield* call(() => fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, messages, stream: true, ...(options?.tools && { tools: options.tools.toOllamaFormat() }) }),
      signal,
    }));
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
    if (!response.body) throw new Error('No response body');

    const subscription: Subscription<OllamaChatChunk, void> = yield* parseNDJSON<OllamaChatChunk>(response.body);
    let textBuffer = '';
    let thinkingBuffer = '';
    let toolCalls: ToolCall[] = [];
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const pendingEvents: ChatEvent[] = [];

    yield* provide({
      *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
        if (pendingEvents.length > 0) return { done: false, value: pendingEvents.shift()! };

        const next = yield* subscription.next();
        if (next.done) {
          return { done: true, value: { text: textBuffer, thinking: thinkingBuffer || undefined, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage } };
        }

        const chunk = next.value;
        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);

        if (chunk.done) {
          usage = { promptTokens: chunk.prompt_eval_count ?? 0, completionTokens: chunk.eval_count ?? 0, totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0) };
        }

        if (chunk.message.content) { textBuffer += chunk.message.content; pendingEvents.push({ type: 'text', content: chunk.message.content }); }
        if (chunk.message.thinking) { thinkingBuffer += chunk.message.thinking; pendingEvents.push({ type: 'thinking', content: chunk.message.thinking }); }
        if (chunk.message.tool_calls) { toolCalls = [...toolCalls, ...chunk.message.tool_calls]; pendingEvents.push({ type: 'tool_calls', toolCalls: chunk.message.tool_calls }); }

        if (pendingEvents.length > 0) return { done: false, value: pendingEvents.shift()! };
        return yield* this.next();
      },
    });
  });
}

// --- Test Tools ---
const calculatorTool = defineTool({
  name: 'calculator',
  description: 'Perform basic arithmetic',
  parameters: z.object({ expression: z.string().describe('Math expression like "2 + 2"') }),
  *execute({ expression }) {
    if (!/^[\d\s+\-*/().]+$/.test(expression)) throw new Error('Invalid expression');
    return { expression, result: Function(`"use strict"; return (${expression})`)() };
  },
});

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  parameters: z.object({ location: z.string().describe('City name') }),
  *execute({ location }) {
    yield* call(() => new Promise(r => setTimeout(r, 100)));
    return { location, temperature: 22, condition: 'sunny' };
  },
});

const registry = createToolRegistry([calculatorTool, weatherTool]);

// --- Spinner ---
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner() {
  let frameIndex = 0;
  let isShowing = false;
  return {
    tick() {
      frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r${SPINNER_FRAMES[frameIndex]} thinking...`);
      isShowing = true;
    },
    clear() {
      if (isShowing) {
        process.stdout.write('\r' + ' '.repeat(15) + '\r');
        isShowing = false;
      }
    },
  };
}

// --- Test ---
await main(function* () {
  console.log('Testing STREAMING tool calling with', MODEL_NAME, '\n');

  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are a helpful assistant. When the user asks about multiple things, call multiple tools in parallel.' },
    { role: 'user', content: 'What is 123 * 456 AND what is the weather in Tokyo? Use both tools at the same time.' },
  ];

  let iterations = 0;
  while (iterations < 5) {
    iterations++;
    console.log(`\n--- Iteration ${iterations} ---`);
    process.stdout.write('Response: ');

    const spinner = createSpinner();
    let eventCounts = { text: 0, thinking: 0, tool_calls: 0 };

    const result = yield* consumeAsync(
      useChatStream(messages, { tools: registry }),
      function* (event) {
        eventCounts[event.type]++;

        if (event.type === 'text') {
          spinner.clear();
          yield* call(() => process.stdout.write(event.content));
        }

        if (event.type === 'thinking') {
          spinner.tick();
        }

        if (event.type === 'tool_calls') {
          spinner.clear();
        }
      }
    );

    spinner.clear();

    console.log('\n\nEvent counts:', eventCounts);
    console.log('Usage:', result.usage);

    if (result.toolCalls?.length) {
      console.log(`\nTool calls: ${result.toolCalls.length}`);
      for (const tc of result.toolCalls) {
        console.log(`  - ${tc.function.name}(${JSON.stringify(tc.function.arguments)})`);
      }

      const results = yield* all(result.toolCalls.map(tc => executeToolCall(registry, tc)));
      messages.push({ role: 'assistant', content: result.text, tool_calls: result.toolCalls });

      for (const r of results) {
        if (r.ok) {
          console.log(`  Result [${r.value.id}]: ${r.value.content}`);
          messages.push({ role: 'tool', tool_call_id: r.value.id, content: r.value.content });
        } else {
          console.log(`  Error [${r.error.callId}]: ${r.error.message}`);
          messages.push({ role: 'tool', tool_call_id: r.error.callId, content: `Error: ${r.error.message}` });
        }
      }
    } else {
      console.log('\nFinal text response received!');
      if (result.thinking) {
        console.log('Thinking captured:', result.thinking.length, 'chars');
      }
      messages.push({ role: 'assistant', content: result.text });
      break;
    }
  }

  console.log('\nDone!');
});
