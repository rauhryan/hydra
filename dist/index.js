import { createContext, resource, call, spawn, useScope, createSignal, suspend } from 'effection';
import express from 'express';
import httpProxy from 'http-proxy';

// src/server-resource.ts
var ServerDaemonError = class extends Error {
  hostname;
  port;
  cause;
  constructor(hostname, port, cause) {
    super(`Server "${hostname}" on port ${port} unexpectedly closed${cause ? `: ${cause.message}` : ""}`);
    this.name = "ServerDaemonError";
    this.hostname = hostname;
    this.port = port;
    this.cause = cause;
  }
};
function useExpressServer(port, hostname) {
  return resource(function* (provide) {
    const app = express();
    app.disable("x-powered-by");
    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        hostname,
        port,
        uptime: process.uptime()
      });
    });
    app.use((req, res) => {
      res.json({
        message: `Hello from ${hostname}!`,
        backend: {
          hostname,
          port
        },
        request: {
          method: req.method,
          path: req.path,
          headers: {
            host: req.get("host"),
            "x-forwarded-for": req.get("x-forwarded-for")
          }
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    const server = yield* call(() => new Promise((resolve, reject) => {
      const srv = app.listen(port, () => {
        console.log(`[${hostname}] Server started on port ${port}`);
        resolve(srv);
      });
      srv.on("error", reject);
    }));
    try {
      yield* provide({ app, server, port, hostname });
    } finally {
      console.log(`[${hostname}] Closing server on port ${port}...`);
      server.close();
      yield* call(() => new Promise((resolve) => {
        server.on("close", resolve);
      }));
      console.log(`[${hostname}] Server closed`);
    }
  });
}
function* useExpressServerDaemon(port, hostname) {
  const handle = yield* useExpressServer(port, hostname);
  yield* spawn(function* () {
    const error = yield* call(() => new Promise((resolve) => {
      handle.server.on("close", () => resolve(void 0));
      handle.server.on("error", (err) => resolve(err));
    }));
    throw new ServerDaemonError(hostname, port, error);
  });
  return handle;
}
var ServerPoolContext = createContext("server-pool");
function useServerPool(config) {
  return resource(function* (provide) {
    const { basePort, maxServers = 100 } = config;
    const servers = /* @__PURE__ */ new Map();
    const serverTasks = /* @__PURE__ */ new Map();
    const pendingCreations = /* @__PURE__ */ new Map();
    let nextPort = basePort;
    const scope = yield* useScope();
    const events = createSignal();
    function emitEvent(event) {
      events.send(event);
    }
    function* doSpawnServer(hostname, port) {
      const info = {
        hostname,
        port,
        app: null,
        server: null,
        task: null,
        startedAt: /* @__PURE__ */ new Date()
      };
      servers.set(hostname, info);
      let resolveReady;
      let rejectReady;
      const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const task = scope.run(function* () {
        try {
          const handle = yield* useExpressServerDaemon(port, hostname);
          info.app = handle.app;
          info.server = handle.server;
          emitEvent({ type: "started", hostname, port });
          resolveReady(info);
          yield* suspend();
        } catch (error) {
          emitEvent({
            type: "error",
            hostname,
            error,
            message: error.message
          });
          rejectReady(error);
          throw error;
        } finally {
          emitEvent({ type: "stopped", hostname });
          servers.delete(hostname);
          serverTasks.delete(hostname);
        }
      });
      info.task = task;
      serverTasks.set(hostname, task);
      return yield* call(() => readyPromise);
    }
    async function getOrCreate(hostname) {
      const existing = servers.get(hostname);
      if (existing && existing.server) {
        return existing;
      }
      const pending = pendingCreations.get(hostname);
      if (pending) {
        return pending;
      }
      if (servers.size >= maxServers) {
        const error = new Error(`Maximum number of servers (${maxServers}) reached`);
        emitEvent({ type: "error", hostname, error, message: error.message });
        throw error;
      }
      const port = nextPort++;
      console.log(`[Pool] Creating server for "${hostname}" on port ${port}`);
      const spawnPromise = scope.run(function* () {
        return yield* doSpawnServer(hostname, port);
      });
      pendingCreations.set(hostname, spawnPromise);
      try {
        return await spawnPromise;
      } finally {
        pendingCreations.delete(hostname);
      }
    }
    function get(hostname) {
      return servers.get(hostname);
    }
    function list() {
      return Array.from(servers.values()).filter((s) => s.server !== null);
    }
    async function shutdown(hostname) {
      const task = serverTasks.get(hostname);
      if (task) {
        console.log(`[Pool] Requesting shutdown for "${hostname}"`);
        await task.halt();
      }
    }
    const pool = {
      getOrCreate,
      get,
      list,
      shutdown,
      events
      // Expose the event stream for subscribers
    };
    yield* ServerPoolContext.set(pool);
    console.log(`[Pool] Server pool ready (base port: ${basePort})`);
    try {
      yield* provide(pool);
    } finally {
      console.log(`[Pool] Shutting down all servers...`);
      console.log(`[Pool] ${servers.size} server(s) will be cleaned up`);
      events.close(void 0);
    }
  });
}
function extractHostname(req, defaultHostname) {
  const host = req.get("host") || "";
  const hostWithoutPort = host.split(":")[0] ?? "";
  if (hostWithoutPort.includes(".")) {
    const parts = hostWithoutPort.split(".");
    return parts[0] ?? defaultHostname;
  }
  const appHeader = req.get("x-app-name");
  if (appHeader) {
    return appHeader;
  }
  return defaultHostname;
}
function useSwitchboard(config, pool) {
  return resource(function* (provide) {
    const { port, defaultHostname = "default" } = config;
    const app = express();
    const proxy = httpProxy.createProxyServer({
      // Don't change the host header
      changeOrigin: false,
      // WebSocket support
      ws: true
    });
    proxy.on("error", (err, _req, res) => {
      console.error(`[Switchboard] Proxy error:`, err.message);
      if (res && "writeHead" in res && !res.headersSent) {
        res.status(502).json({
          error: "Bad Gateway",
          message: err.message
        });
      }
    });
    proxy.on("proxyReq", (_proxyReq, req, _res) => {
      const hostname = extractHostname(req, defaultHostname);
      console.log(`[Switchboard] Proxying ${req.method} ${req.url} -> ${hostname}`);
    });
    app.disable("x-powered-by");
    app.get("/__switchboard/health", (_req, res) => {
      res.json({
        status: "ok",
        servers: pool.list().map((s) => ({
          hostname: s.hostname,
          port: s.port,
          uptime: Date.now() - s.startedAt.getTime()
        }))
      });
    });
    app.get("/__switchboard/servers", (_req, res) => {
      res.json({
        servers: pool.list().map((s) => ({
          hostname: s.hostname,
          port: s.port,
          startedAt: s.startedAt.toISOString()
        }))
      });
    });
    app.use(async (req, res, next) => {
      try {
        const hostname = extractHostname(req, defaultHostname);
        console.log(`[Switchboard] Request for hostname: "${hostname}"`);
        const serverInfo = await pool.getOrCreate(hostname);
        const target = `http://localhost:${serverInfo.port}`;
        proxy.web(req, res, { target }, (err) => {
          if (err) {
            console.error(`[Switchboard] Proxy failed:`, err.message);
            if (!res.headersSent) {
              res.status(502).json({
                error: "Bad Gateway",
                message: `Failed to proxy to ${hostname}: ${err.message}`
              });
            }
          }
        });
      } catch (error) {
        console.error(`[Switchboard] Error:`, error);
        next(error);
      }
    });
    app.use((err, _req, res, _next) => {
      console.error(`[Switchboard] Unhandled error:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal Server Error",
          message: err.message
        });
      }
    });
    const server = yield* call(() => new Promise((resolve, reject) => {
      const srv = app.listen(port, () => {
        console.log(`[Switchboard] Listening on port ${port}`);
        console.log(`[Switchboard] Try: curl -H "Host: myapp.localhost" http://localhost:${port}/`);
        resolve(srv);
      });
      srv.on("error", reject);
    }));
    server.on("upgrade", async (req, socket, head) => {
      try {
        const hostname = extractHostname(req, defaultHostname);
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
      console.log(`[Switchboard] Closing proxy server...`);
      proxy.close();
      server.close();
      yield* call(() => new Promise((resolve) => {
        server.on("close", resolve);
      }));
      console.log(`[Switchboard] Proxy server closed`);
    }
  });
}

export { ServerDaemonError, ServerPoolContext, useExpressServer, useExpressServerDaemon, useServerPool, useSwitchboard };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map