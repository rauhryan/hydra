import {
  main, each, spawn, resource, suspend, Operation,
} from "effection";
import { x, type TinyProcess } from "@effectionx/tinyexec";
import express from "express";
import httpProxy from "http-proxy";

const app = express();
const proxy = httpProxy.createProxyServer({});

// Proxy /foo/*
app.use("/foo", (req, res) => {
  proxy.web(req, res, { target: "http://localhost:3001" });
});

// Proxy /bar/*
app.use("/bar", (req, res) => {
  proxy.web(req, res, { target: "http://localhost:3002" });
});

function useDynobase(path: string, port: number): Operation<TinyProcess> {
  return resource(function*(provide) {
    let proc = yield* x("pnpm", 'run server'.split(" "), {
      nodeOptions: {
        env: {
          "VITE_BASE_URL": `/${path}`,
          "PORT": port.toString(),
        },
      },

    })

    yield* spawn(function*() {
      for (let line of yield* each(proc.lines)) {
        console.log("/foo ", line)
        yield* each.next()
      }
    })

    try {
      yield* provide(proc)
    } finally {
      console.log("shutdown?")
    }
  })
}
await main(function*() {
  // Run a command and get the result
  yield* useDynobase("foo", 3001)
  yield* useDynobase("bar", 3002)

  // yield* spawn(function*() {
  //   for (let line of yield* each(serverFoo.lines)) {
  //     console.log("/foo ", line)
  //     yield* each.next()
  //   }
  // })
  //
  // yield* spawn(function*() {
  //   for (let line of yield* each(serverBar.lines)) {
  //     console.log("/bar ", line)
  //     yield* each.next()
  //   }
  // })

  yield* suspend()
});
