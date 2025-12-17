/**
 * structured-output.ts
 *
 * Ollama structured outputs with Effection streaming.
 *
 * Demonstrates:
 * - Zod schema → JSON Schema via z.toJSONSchema()
 * - format parameter for constrained generation
 * - Spinner while streaming (partial JSON not shown)
 * - Thinking captured in result
 * - Tool call support (model can gather data before responding)
 * - Result type for type-safe error handling
 */
import type { Operation, Stream, Subscription } from 'effection';
import { main, resource, call, all, useAbortSignal, sleep } from 'effection';
import { z } from 'zod';

import { ok, err, type Result } from './shared/result.ts';
import {
  OLLAMA_API_URL,
  DEFAULT_MODEL,
  parseNDJSON,
  usageFromChunk,
  emptyUsage,
  type OllamaMessage,
  type OllamaChatChunk,
  type ToolCall,
  type TokenUsage,
} from './shared/ollama.ts';
import {
  defineTool,
  createToolRegistry,
  executeToolCall,
  type ToolRegistry,
} from './shared/tools.ts';
import { useSpinner } from './spinner-resource.ts';

// --- Structured Output Types ---

/** Result of a successful structured chat */
export interface StructuredResult<T> {
  data: T;              // Parsed & validated via Zod
  raw: string;          // Raw JSON string from model
  thinking?: string;    // Chain-of-thought if present
  usage: TokenUsage;
}

/** Error when parsing/validating structured output */
export interface ParseError {
  phase: 'json' | 'validation';
  message: string;
  raw: string;          // The raw text that failed
  cause?: unknown;      // Original error
}

/** Events emitted during structured streaming */
export type StructuredEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] };

// --- Structured Chat Stream ---

/**
 * Stream a structured chat response from Ollama.
 *
 * - Emits 'thinking' and 'tool_calls' events
 * - Accumulates text internally (partial JSON not emitted)
 * - Returns Result with parsed data or parse error
 *
 * @param messages - Chat messages
 * @param schema - Zod schema for the expected response
 * @param options - Optional tools registry
 */
export function useStructuredChat<T extends z.ZodType>(
  messages: OllamaMessage[],
  schema: T,
  options?: { tools?: ToolRegistry }
): Stream<StructuredEvent, Result<StructuredResult<z.infer<T>>, ParseError>> {
  return resource(function* (provide) {
    const signal = yield* useAbortSignal();

    const request = {
      model: DEFAULT_MODEL,
      messages,
      stream: true,
      format: z.toJSONSchema(schema),
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
    let usage: TokenUsage = emptyUsage();

    // Queue of events to yield
    const pendingEvents: StructuredEvent[] = [];

    yield* provide({
      *next(): Operation<IteratorResult<StructuredEvent, Result<StructuredResult<z.infer<T>>, ParseError>>> {
        // Yield any pending events first
        if (pendingEvents.length > 0) {
          return { done: false, value: pendingEvents.shift()! };
        }

        // Read next chunk from Ollama
        const next = yield* subscription.next();

        if (next.done) {
          // Stream finished - if we have tool calls, return them (caller handles loop)
          if (toolCalls.length > 0) {
            return {
              done: true,
              value: err({
                phase: 'json',
                message: 'Tool calls pending - caller should handle tool loop',
                raw: textBuffer,
              }),
            };
          }

          // Parse and validate the accumulated text
          let parsed: unknown;
          try {
            parsed = JSON.parse(textBuffer);
          } catch (e) {
            return {
              done: true,
              value: err({
                phase: 'json',
                message: e instanceof Error ? e.message : 'JSON parse failed',
                raw: textBuffer,
                cause: e,
              }),
            };
          }

          const validated = schema.safeParse(parsed);
          if (!validated.success) {
            return {
              done: true,
              value: err({
                phase: 'validation',
                message: validated.error.message,
                raw: textBuffer,
                cause: validated.error,
              }),
            };
          }

          return {
            done: true,
            value: ok({
              data: validated.data,
              raw: textBuffer,
              thinking: thinkingBuffer || undefined,
              usage,
            }),
          };
        }

        const chunk = next.value;

        if (chunk.error) {
          throw new Error(`Ollama: ${chunk.error}`);
        }

        // Capture usage from final chunk
        if (chunk.done) {
          usage = usageFromChunk(chunk);
        }

        // Accumulate text (don't emit - it's partial JSON)
        if (chunk.message.content) {
          textBuffer += chunk.message.content;
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

        return yield* this.next();
      },
    });
  });
}

// --- Structured Chat with Tool Loop ---

/**
 * Execute a structured chat with automatic tool handling.
 * Runs the full tool loop until model returns structured JSON.
 */
function* structuredChat<T extends z.ZodType>(
  initialMessages: OllamaMessage[],
  schema: T,
  options?: { tools?: ToolRegistry; maxIterations?: number }
): Operation<Result<StructuredResult<z.infer<T>>, ParseError>> {
  const messages = [...initialMessages];
  const registry = options?.tools;
  const maxIterations = options?.maxIterations ?? 10;
  const spinner = yield* useSpinner();

  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    let toolCallsReceived: ToolCall[] = [];
    let streamResult: Result<StructuredResult<z.infer<T>>, ParseError> | undefined;

    // Consume the stream
    yield* spinner.start('thinking');

    const stream = useStructuredChat(messages, schema, { tools: registry });
    const subscription: Subscription<StructuredEvent, Result<StructuredResult<z.infer<T>>, ParseError>> = yield* stream;

    let next = yield* subscription.next();
    while (!next.done) {
      const event = next.value;

      if (event.type === 'tool_calls') {
        toolCallsReceived = [...toolCallsReceived, ...event.toolCalls];
      }
      // thinking events keep spinner going (already started)

      next = yield* subscription.next();
    }

    yield* spinner.stop();
    streamResult = next.value;

    // If we got tool calls, execute them and continue
    if (toolCallsReceived.length > 0 && registry) {
      console.log(`[Calling ${toolCallsReceived.length} tool(s)...]`);

      const toolResults = yield* all(
        toolCallsReceived.map((tc) => executeToolCall(registry, tc))
      );

      // Add assistant message with tool calls (content might be empty)
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: toolCallsReceived,
      });

      // Add tool results
      for (const result of toolResults) {
        if (result.ok) {
          console.log(`  [${result.value.id}] OK`);
          messages.push({
            role: 'tool',
            tool_call_id: result.value.id,
            content: result.value.content,
          });
        } else {
          console.log(`  [${result.error.callId}] ERROR: ${result.error.message}`);
          messages.push({
            role: 'tool',
            tool_call_id: result.error.callId,
            content: `Error: ${result.error.message}`,
          });
        }
      }

      continue; // Loop back for model to process tool results
    }

    // No tool calls - we should have a result
    return streamResult!;
  }

  return err({
    phase: 'json',
    message: `Max iterations (${maxIterations}) reached`,
    raw: '',
  });
}

// --- Demo ---

await main(function* () {
  console.log('Ollama Structured Output Demo\n');
  console.log(`Model: ${DEFAULT_MODEL}\n`);

  // --- Example 1: Simple structured output ---
  console.log('═'.repeat(50));
  console.log('1. Country Information\n');

  const Country = z.object({
    name: z.string(),
    capital: z.string(),
    languages: z.array(z.string()),
    population: z.number().describe('Approximate population'),
    funFact: z.string().describe('An interesting fact about the country'),
  });

  const countryResult = yield* structuredChat(
    [{ role: 'user', content: 'Tell me about Japan. Return as JSON.' }],
    Country
  );

  if (countryResult.ok) {
    const { data } = countryResult.value;
    console.log(`Country: ${data.name}`);
    console.log(`Capital: ${data.capital}`);
    console.log(`Languages: ${data.languages.join(', ')}`);
    console.log(`Population: ${data.population.toLocaleString()}`);
    console.log(`Fun fact: ${data.funFact}`);
    console.log(`\n[Tokens: ${countryResult.value.usage.totalTokens}]`);
  } else {
    console.error('Parse error:', countryResult.error.message);
  }

  yield* sleep(500);

  // --- Example 2: Data extraction ---
  console.log('\n' + '═'.repeat(50));
  console.log('2. Extract Pets from Text\n');

  const PetList = z.object({
    pets: z.array(
      z.object({
        name: z.string(),
        species: z.enum(['cat', 'dog', 'bird', 'fish', 'rabbit', 'other']),
        age: z.number(),
        color: z.string().optional(),
        favoriteActivity: z.string().optional(),
      })
    ),
  });

  const petsResult = yield* structuredChat(
    [
      {
        role: 'user',
        content: `Extract pet information from this text and return as JSON:
        
"I have three pets! Mochi is my 3 year old orange tabby cat who loves napping in sunbeams. 
Bruno is a 5 year old black labrador who goes crazy for fetch. 
And little Tweety is a 1 year old yellow canary who sings every morning."`,
      },
    ],
    PetList
  );

  if (petsResult.ok) {
    console.log('Extracted pets:');
    for (const pet of petsResult.value.data.pets) {
      const color = pet.color ? `${pet.color} ` : '';
      const activity = pet.favoriteActivity ? ` - loves ${pet.favoriteActivity}` : '';
      console.log(`  • ${pet.name}: ${pet.age}yo ${color}${pet.species}${activity}`);
    }
    console.log(`\n[Tokens: ${petsResult.value.usage.totalTokens}]`);
  } else {
    console.error('Parse error:', petsResult.error.message);
  }

  yield* sleep(500);

  // --- Example 3: Sentiment analysis ---
  console.log('\n' + '═'.repeat(50));
  console.log('3. Sentiment Analysis\n');

  const Sentiment = z.object({
    sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
    confidence: z.number().min(0).max(1),
    emotions: z.array(z.string()).describe('Emotions detected in the text'),
    summary: z.string().describe('Brief explanation of the sentiment'),
  });

  const sentimentResult = yield* structuredChat(
    [
      {
        role: 'user',
        content: `Analyze the sentiment of this review and return as JSON:

"The movie started incredibly slow and I almost walked out. But then the plot twist in the middle completely hooked me, and the ending was absolutely mind-blowing! I cried, I laughed, I was on the edge of my seat. Definitely worth the patience."`,
      },
    ],
    Sentiment
  );

  if (sentimentResult.ok) {
    const { sentiment, confidence, emotions, summary } = sentimentResult.value.data;
    console.log(`Sentiment: ${sentiment} (${(confidence * 100).toFixed(0)}% confidence)`);
    console.log(`Emotions: ${emotions.join(', ')}`);
    console.log(`Summary: ${summary}`);
    console.log(`\n[Tokens: ${sentimentResult.value.usage.totalTokens}]`);
  } else {
    console.error('Parse error:', sentimentResult.error.message);
  }

  yield* sleep(500);

  // --- Example 4: Structured output with tool call ---
  console.log('\n' + '═'.repeat(50));
  console.log('4. Weather Report (with tool call)\n');

  const WeatherReport = z.object({
    location: z.string(),
    temperature: z.number(),
    unit: z.enum(['celsius', 'fahrenheit']),
    conditions: z.string(),
    recommendation: z.string().describe('What to wear or do based on the weather'),
  });

  const weatherTool = defineTool({
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: z.object({
      location: z.string().describe('City name'),
    }),
    *execute({ location }) {
      // Simulated weather data
      yield* sleep(100);
      const temps: Record<string, number> = { Tokyo: 22, London: 14, Sydney: 28, NYC: 18 };
      const conditions: Record<string, string> = {
        Tokyo: 'partly cloudy',
        London: 'rainy',
        Sydney: 'sunny',
        NYC: 'windy',
      };
      return {
        temperature: temps[location] ?? 20,
        conditions: conditions[location] ?? 'clear',
        unit: 'celsius',
      };
    },
  });

  const registry = createToolRegistry([weatherTool]);

  const weatherResult = yield* structuredChat(
    [
      {
        role: 'system',
        content: 'You have access to a weather tool. Use it to get real weather data, then return a structured weather report as JSON.',
      },
      {
        role: 'user',
        content: "What's the weather like in Tokyo? Give me a recommendation for what to wear.",
      },
    ],
    WeatherReport,
    { tools: registry }
  );

  if (weatherResult.ok) {
    const { location, temperature, unit, conditions, recommendation } = weatherResult.value.data;
    console.log(`\n${location}: ${temperature}°${unit === 'celsius' ? 'C' : 'F'}, ${conditions}`);
    console.log(`Recommendation: ${recommendation}`);
    console.log(`\n[Tokens: ${weatherResult.value.usage.totalTokens}]`);
  } else {
    console.error('Parse error:', weatherResult.error.message);
    console.error('Raw:', weatherResult.error.raw.slice(0, 200));
  }

  console.log('\n' + '═'.repeat(50));
  console.log('Demo complete!');
});
