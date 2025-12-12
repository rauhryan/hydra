# The World's Greatest Effection Tutorial

**Learn structured concurrency by building a multiplex HTTP proxy**

---

## What You'll Learn

Effection is a structured concurrency library for JavaScript that guarantees:

1. **No operation runs longer than its parent** - automatic cleanup
2. **Every operation exits fully** - `finally` blocks always run
3. **It's just JavaScript** - use `if`, `for`, `while`, `try/catch` as normal

By the end of this tutorial, you'll build a **multiplex HTTP proxy** that dynamically spawns Express servers and routes requests through a switchboard - all managed by Effection.

---

## Tutorial Structure

### Part 1: Foundation - "Why Effection Exists"
- [1.1 The Problem with Promises](./01-problem-with-promises.md) - Why async/await leaks
- [1.2 Operations](./02-operations.md) - The lazy alternative
- [1.3 Actions](./03-actions.md) - Bridging callbacks

### Part 2: Concurrency - "Doing Many Things at Once"
- [2.1 Spawn](./04-spawn.md) - Child operations
- [2.2 Combinators](./05-combinators.md) - `all()` and `race()`
- [2.3 Resources](./06-resources.md) - Long-running services

### Part 3: Communication - "Operations Talking to Each Other"
- [3.1 Channels and Streams](./07-channels-streams.md) - Pub/sub messaging
- [3.2 Signals](./08-signals.md) - Events from callbacks
- [3.3 Context](./09-context.md) - Sharing values down the tree

### Part 4: Integration
- [4.1 Scope API](./10-scope-api.md) - Embedding Effection in Express, React, etc.

### Part 5: Capstone - Multiplex HTTP Proxy (Coming Soon)
Build a production-ready proxy that:
- Dynamically spawns Express servers on demand
- Routes requests via hostname/path matching
- Manages server lifecycle with proper cleanup
- Demonstrates all Effection concepts together

---

## Prerequisites

- Solid JavaScript/TypeScript knowledge
- Familiarity with `async/await`
- Basic understanding of Node.js
- Experience with Express is helpful but not required

---

## Setup

```bash
npm install effection
```

For the capstone project, you'll also need:

```bash
npm install express
npm install -D @types/express tsx typescript
```

---

## Running Examples

All code examples are written in TypeScript and can be run with:

```bash
npx tsx <filename>.ts
```

Make sure your `tsconfig.json` has:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "strict": true,
    "esModuleInterop": true
  }
}
```

---

## Let's Begin!

Start with [Chapter 1.1: The Problem with Promises](./01-problem-with-promises.md)
