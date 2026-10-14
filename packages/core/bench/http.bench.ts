/**
 * End-to-end HTTP benchmark, bare Node.js vs Pype vs Express: `npm run bench`.
 *
 * Runs from the compiled build, since ts-node itself would slow every server
 * down. Each run is preceded by a one-second warm-up.
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
      { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_ENV: "production" } },
    );
    child.stdout!.once("data", () => resolve(child));
    child.once("error", reject);
  });
}

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
  return { rps: result.requests.average, latency: result.latency.average, errors: result.non2xx + result.errors };
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

  console.log(`${"route".padEnd(46)} ${"pype req/s".padStart(11)} ${"express req/s".padStart(14)} ${"speedup".padStart(8)}`);

  for (const [name, path] of Object.entries(lookups)) {
    const results: Record<string, { rps: number }> = {};

    for (const framework of ["pype", "express"] as const) {
      const url = `http://127.0.0.1:${ports[framework]}${path}`;
      await run(url, 1);
      results[framework] = await run(url, DURATION);
    }

    const speedup = results.pype.rps / results.express.rps;
    console.log(
      `${name.padEnd(46)} ${results.pype.rps.toFixed(0).padStart(11)} ${results.express.rps.toFixed(0).padStart(14)} ${(speedup.toFixed(2) + "x").padStart(8)}`,
    );
  }

  for (const server of Object.values(servers)) server.kill();
}

main();
