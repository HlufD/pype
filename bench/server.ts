// Starts a Pype or Express server with the benchmark routes:
//   node dist/bench/server.js <node|pype|express> <port>
import { createServer } from "http";
import { Pype } from "../src/core/server";
import { routes } from "./routes";

const [framework, port] = [process.argv[2], Number(process.argv[3])];

const handler = (req: any, res: any) => {
  res.json({ ok: true, params: req.params });
};

if (framework === "node") {
  // ceiling: bare Node.js, no routing
  createServer((_req, res) => {
    const body = JSON.stringify({ ok: true, params: {} });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }).listen(port, () => console.log("ready"));
} else if (framework === "express") {
  // required here so the Pype process doesn't load Express and its deps
  const express = require("express") as typeof import("express");
  const app = express();
  for (const [method, path] of routes) {
    // Express 5 (path-to-regexp v8) needs named wildcards
    app[method](path.replace(/\*$/, "*splat"), handler);
  }
  app.listen(port, () => console.log("ready"));
} else {
  const app = new Pype();
  for (const [method, path] of routes) app[method](path, handler);
  app.listen(port, () => console.log("ready"));
}

// exit cleanly so --cpu-prof can write its profile
process.on("SIGINT", () => process.exit(0));
