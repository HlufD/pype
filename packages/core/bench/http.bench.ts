/**
 * End-to-end HTTP benchmark, bare Node.js vs Pype vs Express: `npm run bench`.
 *
 * Runs from the compiled build, since ts-node itself would slow every server
 * down. Each run is preceded by a one-second warm-up. After each run the
 * server's RSS, heap and garbage collections per 1000 requests are shown.
 *
 * @packageDocumentation
 */
import { spawn, ChildProcess } from "child_process";
import { extname, join } from "path";
import autocannon from "autocannon";
import { lookups } from "./routes";

/** Seconds per measured run, override with the `DURATION` env var. */
const DURATION = Number(process.env.DURATION ?? 5);

/** Concurrent connections per run. */
const CONNECTIONS = 200;

/** Load-generating threads, so the client isn't the bottleneck. */
const WORKERS = 4;

/**
 * Starts a benchmark server in a child process.
 *
 * @param framework - `"node"`, `"pype"` or `"express"`.
 * @param port - Port to listen on.
 * @returns The child process, once the server is listening.
 */
function start(framework: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const ext = extname(__filename);
    const server = join(__dirname, `server${ext}`);
    const loader = ext === ".ts" ? ["-r", "ts-node/register/transpile-only"] : [];

    const child = spawn(
      process.execPath,
      [...loader, server, framework, String(port)],
      { stdio: ["ignore", "pipe", "inherit", "ipc"], env: { ...process.env, NODE_ENV: "production" } },
    );
    child.stdout!.once("data", () => resolve(child));
    child.once("error", reject);
  });
}

/** Memory use of a benchmark server, see `server.ts`. */
interface Memory {
  rss: number;
  heapUsed: number;
  collections: number;
}

/** Asks a server for its memory use. */
function memory(child: ChildProcess): Promise<Memory> {
  return new Promise((resolve) => {
    child.once("message", (message) => resolve(message as Memory));
    child.send("memory");
  });
}

/** Megabytes, rounded. */
const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(0);

/**
 * Load-tests a URL with autocannon.
 *
 * @returns Average requests per second, average latency and error count.
 */
async function run(url: string, duration: number) {
  const result = await autocannon({
    url,
    connections: CONNECTIONS,
    duration,
    workers: WORKERS,
  });
  return {
    rps: result.requests.average,
    total: result.requests.total,
    latency: result.latency.average,
    errors: result.non2xx + result.errors,
  };
}

/** Runs every lookup against Pype and Express and prints the speedups. */
async function main() {
  const servers = {
    node: await start("node", 4100),
    pype: await start("pype", 4101),
    express: await start("express", 4102),
  };
  const ports = { node: 4100, pype: 4101, express: 4102 };

  console.log(`${DURATION}s per run, ${CONNECTIONS} connections, ${WORKERS} workers\n`);

  const node = await run(`http://127.0.0.1:${ports.node}/`, DURATION);
  console.log(`bare Node.js http server (no routing): ${node.rps.toFixed(0)} req/s\n`);

  console.log(
    `${"route".padEnd(46)} ${"pype req/s".padStart(11)} ${"express req/s".padStart(14)} ${"speedup".padStart(8)}` +
      `  ${"RSS MB p/e".padStart(11)} ${"heap MB p/e".padStart(12)} ${"GC/1k req p/e".padStart(14)}`,
  );

  for (const [name, path] of Object.entries(lookups)) {
    const results: Record<string, { rps: number }> = {};
    const usage: Record<string, Memory & { gcPer1k: number }> = {};

    for (const framework of ["pype", "express"] as const) {
      const url = `http://127.0.0.1:${ports[framework]}${path}`;
      await run(url, 1);
      const before = await memory(servers[framework]);
      const result = await run(url, DURATION);
      const after = await memory(servers[framework]);
      results[framework] = result;
      usage[framework] = { ...after, gcPer1k: ((after.collections - before.collections) / result.total) * 1000 };
    }

    const speedup = results.pype.rps / results.express.rps;
    const pair = (pick: (m: Memory & { gcPer1k: number }) => string) => `${pick(usage.pype)}/${pick(usage.express)}`;
    console.log(
      `${name.padEnd(46)} ${results.pype.rps.toFixed(0).padStart(11)} ${results.express.rps.toFixed(0).padStart(14)} ${(speedup.toFixed(2) + "x").padStart(8)}` +
        `  ${pair((m) => mb(m.rss)).padStart(11)} ${pair((m) => mb(m.heapUsed)).padStart(12)} ${pair((m) => m.gcPer1k.toFixed(2)).padStart(14)}`,
    );
  }

  for (const server of Object.values(servers)) server.kill();
}

main();
