// src/switchboard.ts
// The Switchboard - HTTP proxy that routes to dynamic backends

import type { Operation } from 'effection';
import { resource, call } from 'effection';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import httpProxy from 'http-proxy';
import type { Server } from 'http';
import type { SwitchboardConfig, ServerInfo, ServerPool } from './types';

export interface SwitchboardHandle {
  app: Express;
  server: Server;
  port: number;
}

/**
 * Extracts the app hostname from the request.
 * 
 * Supports formats:
 * - app-name.localhost -> app-name
 * - app-name.localhost:8000 -> app-name
 * - localhost (returns defaultHostname or 'default')
 */
function extractHostname(req: Request, defaultHostname: string): string {
  const host = req.get('host') || '';
  const hostWithoutPort = host.split(':')[0] ?? '';
  
  // Handle patterns like "app-a.localhost" -> "app-a"
  if (hostWithoutPort.includes('.')) {
    const parts = hostWithoutPort.split('.');
    // Take the first part as the app name
    return parts[0] ?? defaultHostname;
  }
  
  // Check for X-App-Name header as alternative
  const appHeader = req.get('x-app-name');
  if (appHeader) {
    return appHeader;
  }
  
  // Default
  return defaultHostname;
}

/**
 * Creates the switchboard proxy resource.
 * 
 * The switchboard:
 * - Listens on the main port
 * - Extracts hostname from requests
 * - Creates backend servers on demand via the pool
 * - Proxies requests to the appropriate backend
 */
export function useSwitchboard(
  config: SwitchboardConfig,
  pool: ServerPool
): Operation<SwitchboardHandle> {
  return resource<SwitchboardHandle>(function* (provide) {
    const { port, defaultHostname = 'default' } = config;
    
    const app: Express = express();
    
    // Create the proxy server
    const proxy = httpProxy.createProxyServer({
      // Don't change the host header
      changeOrigin: false,
      // WebSocket support
      ws: true,
    });
    
    // Handle proxy errors
    proxy.on('error', (err, _req, res) => {
      console.error(`[Switchboard] Proxy error:`, err.message);
      if (res && 'writeHead' in res && !res.headersSent) {
        (res as Response).status(502).json({
          error: 'Bad Gateway',
          message: err.message,
        });
      }
    });
    
    // Log proxied requests
    proxy.on('proxyReq', (_proxyReq, req, _res) => {
      const hostname = extractHostname(req as Request, defaultHostname);
      console.log(`[Switchboard] Proxying ${req.method} ${req.url} -> ${hostname}`);
    });
    
    app.disable('x-powered-by');
    
    // Health check for the switchboard itself
    app.get('/__switchboard/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        servers: pool.list().map((s: ServerInfo) => ({
          hostname: s.hostname,
          port: s.port,
          uptime: Date.now() - s.startedAt.getTime(),
        })),
      });
    });
    
    // List all running servers
    app.get('/__switchboard/servers', (_req: Request, res: Response) => {
      res.json({
        servers: pool.list().map((s: ServerInfo) => ({
          hostname: s.hostname,
          port: s.port,
          startedAt: s.startedAt.toISOString(),
        })),
      });
    });
    
    // Main proxy handler
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Extract the target hostname
        const hostname = extractHostname(req, defaultHostname);
        
        console.log(`[Switchboard] Request for hostname: "${hostname}"`);
        
        // Get or create the backend server (now using clean Promise API)
        const serverInfo: ServerInfo = await pool.getOrCreate(hostname);
        
        // Proxy the request to the backend
        const target = `http://localhost:${serverInfo.port}`;
        
        proxy.web(req, res, { target }, (err) => {
          if (err) {
            console.error(`[Switchboard] Proxy failed:`, err.message);
            if (!res.headersSent) {
              res.status(502).json({
                error: 'Bad Gateway',
                message: `Failed to proxy to ${hostname}: ${err.message}`,
              });
            }
          }
        });
      } catch (error) {
        console.error(`[Switchboard] Error:`, error);
        next(error);
      }
    });
    
    // Error handler
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error(`[Switchboard] Unhandled error:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal Server Error',
          message: err.message,
        });
      }
    });
    
    // Start listening and wait for it to be ready
    const server: Server = yield* call(() => new Promise<Server>((resolve, reject) => {
      const srv = app.listen(port, () => {
        console.log(`[Switchboard] Listening on port ${port}`);
        console.log(`[Switchboard] Try: curl -H "Host: myapp.localhost" http://localhost:${port}/`);
        resolve(srv);
      });
      srv.on('error', reject);
    }));
    
    // Handle WebSocket upgrades
    server.on('upgrade', async (req, socket, head) => {
      try {
        const hostname = extractHostname(req as unknown as Request, defaultHostname);
        const serverInfo = await pool.getOrCreate(hostname);
        const target = `http://localhost:${serverInfo.port}`;
        
        proxy.ws(req, socket, head, { target });
      } catch (error) {
        console.error(`[Switchboard] WebSocket upgrade failed:`, error);
        socket.destroy();
      }
    });
    
    try {
      yield* provide({ app, server, port });
    } finally {
      // Graceful shutdown - wait for server to close (lspx pattern)
      console.log(`[Switchboard] Closing proxy server...`);
      proxy.close();
      server.close();
      yield* call(() => new Promise<void>((resolve) => {
        server.on('close', resolve);
      }));
      console.log(`[Switchboard] Proxy server closed`);
    }
  });
}
