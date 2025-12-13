// start.ts
// Effection Tutorial Capstone: Multiplex HTTP Proxy
//
// This demonstrates:
// - main() for graceful shutdown
// - Resources for long-running services
// - spawn() for dynamic server creation
// - Context for sharing the server pool
// - Scope API for Express integration
// - Proper cleanup of all servers on Ctrl+C
// - Signal-based events for observability (lspx pattern)

import { main, suspend, spawn, each } from 'effection';
import { useServerPool } from './src/server-pool.ts';
import { useSwitchboard } from './src/switchboard.ts';
import type { ServerEvent } from './src/types.ts';

const SWITCHBOARD_PORT = 8000;
const BASE_SERVER_PORT = 3001;

await main(function*() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           Effection Multiplex HTTP Proxy                     ║');
  console.log('║                                                              ║');
  console.log('║  This proxy dynamically spawns Express servers based on      ║');
  console.log('║  the Host header. All servers are managed by Effection       ║');
  console.log('║  and will be gracefully shut down when you press Ctrl+C.     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Create the server pool
  // This resource spawns and manages Express servers on demand
  const pool = yield* useServerPool({
    basePort: BASE_SERVER_PORT,
    maxServers: 10,
  });

  // Subscribe to pool events for observability (lspx pattern)
  yield* spawn(function*() {
    for (const event of yield* each(pool.events)) {
      const e = event as ServerEvent;
      switch (e.type) {
        case 'started':
          console.log(`[Events] Server started: ${e.hostname} on port ${e.port}`);
          break;
        case 'stopped':
          console.log(`[Events] Server stopped: ${e.hostname}`);
          break;
        case 'error':
          console.error(`[Events] Server error: ${e.hostname} - ${e.message}`);
          break;
      }
      yield* each.next();
    }
  });

  // Create the switchboard
  // This proxies requests to the appropriate backend based on Host header
  yield* useSwitchboard(
    { port: SWITCHBOARD_PORT, defaultHostname: 'default' },
    pool
  );

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Try these commands:                                         ║');
  console.log('║                                                              ║');
  console.log('║  # Default app:                                              ║');
  console.log('║  curl http://localhost:8000/                                 ║');
  console.log('║                                                              ║');
  console.log('║  # Specific apps (creates new servers dynamically):          ║');
  console.log('║  curl -H "Host: app-a.localhost" http://localhost:8000/      ║');
  console.log('║  curl -H "Host: app-b.localhost" http://localhost:8000/      ║');
  console.log('║  curl -H "Host: myapp.localhost" http://localhost:8000/      ║');
  console.log('║                                                              ║');
  console.log('║  # Using X-App-Name header:                                  ║');
  console.log('║  curl -H "X-App-Name: custom" http://localhost:8000/         ║');
  console.log('║                                                              ║');
  console.log('║  # Check health / list servers:                              ║');
  console.log('║  curl http://localhost:8000/__switchboard/health             ║');
  console.log('║  curl http://localhost:8000/__switchboard/servers            ║');
  console.log('║                                                              ║');
  console.log('║  Press Ctrl+C to gracefully shut down all servers.           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Keep running until interrupted
  yield* suspend();
});
