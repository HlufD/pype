/**
 * Starts a benchmark server: `node dist/bench/server.js <node|pype|express> <port>`.
 *
 * - `node` is a bare `http` server without routing, the ceiling.
 * - `express` is required lazily so the Pype process doesn't load Express
 *   and its dependencies. Express 5 (path-to-regexp v8) needs named
 *   wildcards, so `/*` becomes `/*splat`.
 *
 * SIGINT exits cleanly so `--cpu-prof` can write its profile. Over the IPC
 * channel, a `"memory"` message is answered with the process's memory use and
 * the number of garbage collections so far.
 *
 * @packageDocumentation
 */
import { createServer } from "http";
import { PerformanceObserver } from "perf_hooks";
import { Pype } from "../src/core/server";
import { routes } from "./routes";

const [framework, port] = [process.argv[2], Number(process.argv[3])];

/** Handler shared by every route in both frameworks. */
const handler = (req: any, res: any) => {
  res.json({ ok: true, params: req.params });
};

if (framework === "node") {
  createServer((_req, res) => {
    const body = JSON.stringify({ ok: true, params: {} });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }).listen(port, () => console.log("ready"));
} else if (framework === "express") {
  const express = require("express") as typeof import("express");
  const app = express();
  for (const [method, path] of routes) {
    app[method](path.replace(/\*$/, "*splat"), handler);
  }
  app.listen(port, () => console.log("ready"));
} else {
  const app = new Pype();
  for (const [method, path] of routes) app[method](path, handler);
  app.listen(port, () => console.log("ready"));
}

/** Garbage collections since start. */
let collections = 0;
new PerformanceObserver((list) => (collections += list.getEntries().length)).observe({ entryTypes: ["gc"] });

process.on("message", (message) => {
  if (message !== "memory") return;
  const { rss, heapUsed } = process.memoryUsage();
  process.send?.({ rss, heapUsed, collections });
});

process.on("SIGINT", () => process.exit(0));
