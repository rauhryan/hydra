/**
 * shared/tools.ts
 *
 * Tool definition, registry, and execution utilities for Ollama.
 */
import type { Operation } from 'effection';
import { z } from 'zod';
import { ok, err, type Result } from './result.ts';
import type { ToolCall, OllamaTool } from './ollama.ts';

// --- Tool Definition ---

export interface ToolDef<TParams extends z.ZodType, TReturn> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>) => Operation<TReturn>;
}

/**
 * Define a tool with typed parameters and execution.
 * 
 * @example
 * ```ts
 * const weatherTool = defineTool({
 *   name: 'get_weather',
 *   description: 'Get the current weather for a location',
 *   parameters: z.object({
 *     location: z.string().describe('City name'),
 *   }),
 *   *execute({ location }) {
 *     return { location, temperature: 22, conditions: 'sunny' };
 *   },
 * });
 * ```
 */
export function defineTool<TParams extends z.ZodType, TReturn>(
  def: ToolDef<TParams, TReturn>
): ToolDef<TParams, TReturn> {
  return def;
}

// --- Tool Registry ---

export type AnyTool = ToolDef<z.ZodType, unknown>;

export interface ToolRegistry {
  tools: Map<string, AnyTool>;
  toOllamaFormat(): OllamaTool[];
}

/**
 * Create a registry of tools that can be passed to Ollama.
 */
export function createToolRegistry(tools: AnyTool[]): ToolRegistry {
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

export interface ToolResult {
  id: string;
  content: string;
  ok: boolean;
}

export interface ToolError {
  callId: string;
  toolName: string;
  message: string;
  cause?: unknown;
  phase: 'validation' | 'execution' | 'not_found';
}

/**
 * Execute a tool call and return a Result.
 * Handles tool lookup, argument validation, and execution errors.
 */
export function* executeToolCall(
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

  // Validate arguments
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
