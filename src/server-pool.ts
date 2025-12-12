// src/server-pool.ts
// Server Pool - manages dynamic Express server instances
// Refactored to use lspx patterns: signals for events, clean async API

import type { Operation, Task, Context, Scope } from 'effection';
import { resource, createContext, useScope, suspend, createSignal, call } from 'effection';
import type { ServerInfo, ServerPool, ServerEvent } from './types.ts';
import { useExpressServerDaemon } from './server-resource.ts';

/**
 * Context for accessing the server pool from any operation
 */
export const ServerPoolContext: Context<ServerPool> = createContext<ServerPool>('server-pool');

/**
 * Configuration for the server pool
 */
export interface ServerPoolConfig {
  /** Starting port for dynamic servers */
  basePort: number;
  /** Maximum number of servers to spawn */
  maxServers?: number;
}

/**
 * Creates a server pool resource that manages dynamic Express servers.
 * 
 * Refactored with lspx patterns:
 * - Signal-based events for observability (subscribe to pool.events)
 * - Clean Promise-based getOrCreate API (no Operation wrapper needed)
 * - Channel-based spawn worker for clean async bridging
 * - Daemon pattern for server health monitoring
 * 
 * The pool:
 * - Tracks servers by hostname
 * - Assigns ports dynamically starting from basePort
 * - Spawns new servers as child tasks (so they auto-cleanup)
 * - Emits events when servers start/stop/error
 * - Cleans up all servers when the pool is shut down
 */
export function useServerPool(config: ServerPoolConfig): Operation<ServerPool> {
  return resource<ServerPool>(function* (provide) {
    const { basePort, maxServers = 100 } = config;
    
    // Map of hostname -> server info
    const servers = new Map<string, ServerInfo>();
    
    // Map of hostname -> spawn task
    const serverTasks = new Map<string, Task<void>>();
    
    // Pending creation promises to avoid race conditions
    const pendingCreations = new Map<string, Promise<ServerInfo>>();
    
    // Next available port
    let nextPort = basePort;
    
    // Capture scope for spawning servers from callbacks
    const scope: Scope = yield* useScope();
    
    // === Signal for server events (lspx pattern) ===
    // Signals can be sent from anywhere (callbacks, generators, async)
    const events = createSignal<ServerEvent, void>();
    
    /**
     * Emit a server event to all subscribers
     */
    function emitEvent(event: ServerEvent): void {
      events.send(event);
    }
    
    /**
     * Actually spawn a server - called from within Effection context.
     * This is the core spawning logic, extracted for clarity.
     */
    function* doSpawnServer(hostname: string, port: number): Operation<ServerInfo> {
      // Create placeholder info
      const info: ServerInfo = {
        hostname,
        port,
        app: null as any,
        server: null as any,
        task: null as any,
        startedAt: new Date(),
      };
      
      // Store immediately so concurrent requests see it
      servers.set(hostname, info);
      
      // Create a promise that resolves when the server is ready
      let resolveReady: (info: ServerInfo) => void;
      let rejectReady: (err: Error) => void;
      const readyPromise = new Promise<ServerInfo>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      
      // Start the server as a long-lived task using scope.run()
      // The task suspends and stays alive until halted
      const task = scope.run(function* (): Operation<void> {
        try {
          // Use daemon pattern - throws if server unexpectedly closes
          const handle = yield* useExpressServerDaemon(port, hostname);
          
          // Update the server info with real values
          info.app = handle.app;
          info.server = handle.server;
          
          // Emit started event
          emitEvent({ type: 'started', hostname, port });
          
          // Signal that we're ready
          resolveReady!(info);
          
          // Keep running until halted
          yield* suspend();
        } catch (error) {
          // Emit error event
          emitEvent({ 
            type: 'error', 
            hostname, 
            error: error as Error,
            message: (error as Error).message 
          });
          rejectReady!(error as Error);
          throw error;
        } finally {
          // Cleanup when halted
          emitEvent({ type: 'stopped', hostname });
          servers.delete(hostname);
          serverTasks.delete(hostname);
        }
      });
      
      // Store task reference
      info.task = task;
      serverTasks.set(hostname, task);
      
      // Wait for the server to be ready and return
      // Use call() to convert Promise to Operation
      return yield* call(() => readyPromise);
    }
    
    /**
     * Get or create a server - Promise-based API for use anywhere.
     * 
     * This is the primary API - clean, simple, no Operation wrapper.
     * Handles:
     * - Fast path for existing servers
     * - Deduplication of concurrent requests for same hostname
     * - Spawning via scope.run() for proper lifecycle management
     */
    async function getOrCreate(hostname: string): Promise<ServerInfo> {
      // Fast path: server already exists and is ready
      const existing = servers.get(hostname);
      if (existing && existing.server) {
        return existing;
      }
      
      // Check if there's already a pending creation (deduplication)
      const pending = pendingCreations.get(hostname);
      if (pending) {
        return pending;
      }
      
      // Check max servers limit
      if (servers.size >= maxServers) {
        const error = new Error(`Maximum number of servers (${maxServers}) reached`);
        emitEvent({ type: 'error', hostname, error, message: error.message });
        throw error;
      }
      
      // Assign a port
      const port = nextPort++;
      
      console.log(`[Pool] Creating server for "${hostname}" on port ${port}`);
      
      // Create the spawn promise
      const spawnPromise = scope.run(function* (): Operation<ServerInfo> {
        return yield* doSpawnServer(hostname, port);
      });
      
      // Store to deduplicate concurrent requests
      pendingCreations.set(hostname, spawnPromise);
      
      try {
        return await spawnPromise;
      } finally {
        pendingCreations.delete(hostname);
      }
    }
    
    /**
     * Get server info if it exists (sync)
     */
    function get(hostname: string): ServerInfo | undefined {
      return servers.get(hostname);
    }
    
    /**
     * List all running servers (sync)
     */
    function list(): ServerInfo[] {
      return Array.from(servers.values()).filter(s => s.server !== null);
    }
    
    /**
     * Shutdown a specific server
     */
    async function shutdown(hostname: string): Promise<void> {
      const task = serverTasks.get(hostname);
      if (task) {
        console.log(`[Pool] Requesting shutdown for "${hostname}"`);
        await task.halt();
      }
    }
    
    // Create the pool interface
    const pool: ServerPool = {
      getOrCreate,
      get,
      list,
      shutdown,
      events,  // Expose the event stream for subscribers
    };
    
    // Set the context so children can access the pool
    yield* ServerPoolContext.set(pool);
    
    console.log(`[Pool] Server pool ready (base port: ${basePort})`);
    
    try {
      yield* provide(pool);
    } finally {
      console.log(`[Pool] Shutting down all servers...`);
      console.log(`[Pool] ${servers.size} server(s) will be cleaned up`);
      // Close the event signal
      events.close(undefined as void);
    }
  });
}
