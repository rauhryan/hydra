# Capstone Part 1: Architecture Overview

We're going to build a **Multiplex HTTP Proxy** - a switchboard that dynamically spins up Express servers and routes requests to them based on hostname.

---

## What We're Building

```
┌─────────────────────────────────────────────────────────────────┐
│                          main()                                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  Switchboard (Port 8000)                    │ │
│  │  - Receives all incoming HTTP requests                     │ │
│  │  - Parses Host header to determine target                  │ │
│  │  - Proxies request to appropriate backend server           │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼─────────────────────────────────┐ │
│  │                    ServerPool Resource                      │ │
│  │  - Manages Map<hostname, ServerInfo>                       │ │
│  │  - Spawns new Express servers on demand                    │ │
│  │  - Assigns dynamic ports (3001, 3002, ...)                 │ │
│  │  - Cleans up servers when pool shuts down                  │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│     ┌───────────────────────┼───────────────────────┐           │
│     │                       │                       │           │
│     ▼                       ▼                       ▼           │
│  ┌──────┐               ┌──────┐               ┌──────┐         │
│  │app-a │               │app-b │               │app-c │         │
│  │:3001 │               │:3002 │               │:3003 │         │
│  └──────┘               └──────┘               └──────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## User Flow

1. User makes request to `http://localhost:8000` with `Host: app-a.localhost`
2. Switchboard receives request, extracts hostname `app-a`
3. ServerPool checks if `app-a` server exists
4. If not, spawns a new Express server on port 3001
5. Switchboard proxies request to `localhost:3001`
6. Response flows back to user
7. When main() ends (Ctrl+C), all servers are automatically cleaned up

---

## Components

### 1. Express Server Resource (`useExpressServer`)

A resource that:
- Creates an Express app
- Listens on a given port
- Provides the app and server to the caller
- Closes the server on cleanup

### 2. Server Pool Resource (`useServerPool`)

A resource that:
- Maintains a Map of hostname → server info
- Has a `getOrCreate(hostname)` method
- Spawns new servers as child tasks
- Uses Context to share itself with children

### 3. Switchboard Resource (`useSwitchboard`)

A resource that:
- Listens on the main port (8000)
- Uses `http-proxy` to forward requests
- Calls ServerPool to get/create backend servers
- Handles errors gracefully

---

## Effection Concepts Used

| Concept | Usage |
|---------|-------|
| `main()` | Entry point, handles Ctrl+C |
| `resource()` | Express servers, server pool, switchboard |
| `spawn()` | Creating new server tasks |
| `useScope()` | Running operations from Express handlers |
| `Context` | Sharing ServerPool with operations |
| `ensure()` | Cleanup of servers |
| `Channel` | Logging events |
| `suspend()` | Keeping the main process alive |

---

## File Structure

```
src/
├── server-resource.ts    # useExpressServer resource
├── server-pool.ts        # useServerPool resource  
├── switchboard.ts        # useSwitchboard resource
├── types.ts              # Shared types
└── main.ts               # Entry point
```

---

## Let's Build It!

We'll implement each component step by step:

1. [Express Server Resource](./12-capstone-server-resource.md)
2. [Server Pool](./13-capstone-server-pool.md)
3. [Switchboard](./14-capstone-switchboard.md)
4. [Final Assembly](./15-capstone-final.md)

Let's start with the [Express Server Resource](./12-capstone-server-resource.md).
