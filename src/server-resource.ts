// src/server-resource.ts
// Express Server as an Effection Resource

import type { Operation } from 'effection';
import { resource, spawn, call } from 'effection';
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'http';

export interface ExpressServerHandle {
  app: Express;
  server: Server;
  port: number;
  hostname: string;
}

/**
 * Error thrown when a daemon server unexpectedly closes or errors.
 */
export class ServerDaemonError extends Error {
  readonly hostname: string;
  readonly port: number;
  readonly cause?: Error;

  constructor(hostname: string, port: number, cause?: Error) {
    super(`Server "${hostname}" on port ${port} unexpectedly closed${cause ? `: ${cause.message}` : ''}`);
    this.name = 'ServerDaemonError';
    this.hostname = hostname;
    this.port = port;
    this.cause = cause;
  }
}

/**
 * Creates an Express server as an Effection resource.
 * 
 * The server will be automatically closed when the operation ends.
 * Uses graceful shutdown - waits for server to fully close before continuing.
 * 
 * @param port - Port to listen on
 * @param hostname - Hostname for this server (used in responses)
 */
export function useExpressServer(
  port: number,
  hostname: string
): Operation<ExpressServerHandle> {
  return resource<ExpressServerHandle>(function* (provide) {
    const app: Express = express();
    
    // Disable x-powered-by header
    app.disable('x-powered-by');
    
    // Health check endpoint
    app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        hostname,
        port,
        uptime: process.uptime(),
      });
    });
    
    // Default route - shows which backend handled the request
    app.use((req: Request, res: Response) => {
      res.json({
        message: `Hello from ${hostname}!`,
        backend: {
          hostname,
          port,
        },
        request: {
          method: req.method,
          path: req.path,
          headers: {
            host: req.get('host'),
            'x-forwarded-for': req.get('x-forwarded-for'),
          },
        },
        timestamp: new Date().toISOString(),
      });
    });
    
    // Create server and wait for it to be listening
    const server: Server = yield* call(() => new Promise<Server>((resolve, reject) => {
      const srv = app.listen(port, () => {
        console.log(`[${hostname}] Server started on port ${port}`);
        resolve(srv);
      });
      srv.on('error', reject);
    }));
    
    try {
      // Provide the server handle to the caller
      yield* provide({ app, server, port, hostname });
    } finally {
      // Graceful shutdown - wait for server to fully close (lspx pattern)
      console.log(`[${hostname}] Closing server on port ${port}...`);
      server.close();
      yield* call(() => new Promise<void>((resolve) => {
        server.on('close', resolve);
      }));
      console.log(`[${hostname}] Server closed`);
    }
  });
}

/**
 * Creates an Express server daemon - like useExpressServer but throws if
 * the server unexpectedly closes or errors.
 * 
 * This follows the lspx useDaemon pattern: a background task watches the
 * server and throws ServerDaemonError if it dies unexpectedly.
 * 
 * @param port - Port to listen on
 * @param hostname - Hostname for this server (used in responses)
 */
export function* useExpressServerDaemon(
  port: number,
  hostname: string
): Operation<ExpressServerHandle> {
  const handle = yield* useExpressServer(port, hostname);
  
  // Spawn a watcher that throws if server unexpectedly closes (lspx pattern)
  yield* spawn(function* () {
    // Wait for close or error event
    const error = yield* call(() => new Promise<Error | undefined>((resolve) => {
      handle.server.on('close', () => resolve(undefined));
      handle.server.on('error', (err) => resolve(err));
    }));
    
    // If we get here, the server closed unexpectedly
    throw new ServerDaemonError(hostname, port, error);
  });
  
  return handle;
}
