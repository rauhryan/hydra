// src/types.ts
// Shared types for the multiplex proxy

import type { Server } from 'http';
import type { Express } from 'express';
import type { Task, Stream } from 'effection';

/**
 * Information about a running Express server
 */
export interface ServerInfo {
  hostname: string;
  port: number;
  app: Express;
  server: Server;
  task: Task<void>;
  startedAt: Date;
}

/**
 * Server events emitted by the pool (lspx-style signal events)
 */
export type ServerEvent = 
  | { type: 'started'; hostname: string; port: number }
  | { type: 'stopped'; hostname: string }
  | { type: 'error'; hostname: string; error: Error; message: string };

/**
 * The server pool interface exposed to consumers.
 * 
 * Refactored to use Promise-based API (not Operation) for easier integration
 * with Express handlers and other async code.
 */
export interface ServerPool {
  /**
   * Get an existing server or create a new one for the hostname.
   * Returns a Promise for easy use in async handlers.
   */
  getOrCreate(hostname: string): Promise<ServerInfo>;
  
  /**
   * Get server info if it exists (sync)
   */
  get(hostname: string): ServerInfo | undefined;
  
  /**
   * List all running servers (sync)
   */
  list(): ServerInfo[];
  
  /**
   * Shutdown a specific server
   */
  shutdown(hostname: string): Promise<void>;
  
  /**
   * Event stream for server lifecycle events.
   * Subscribe to receive notifications when servers start/stop/error.
   * 
   * @example
   * ```typescript
   * yield* spawn(function*() {
   *   for (const event of yield* each(pool.events)) {
   *     console.log(`[Event] ${event.type}:`, event);
   *     yield* each.next();
   *   }
   * });
   * ```
   */
  events: Stream<ServerEvent, void>;
}

/**
 * Configuration for the switchboard
 */
export interface SwitchboardConfig {
  port: number;
  defaultHostname?: string;
}

/**
 * Configuration for individual app servers
 */
export interface AppServerConfig {
  hostname: string;
  port: number;
}

/**
 * Log event types (deprecated - use ServerEvent instead)
 * @deprecated Use ServerEvent instead
 */
export type LogEvent = 
  | { type: 'server:started'; hostname: string; port: number }
  | { type: 'server:stopped'; hostname: string }
  | { type: 'request:received'; hostname: string; method: string; path: string }
  | { type: 'request:proxied'; hostname: string; port: number }
  | { type: 'error'; message: string; error?: Error };
