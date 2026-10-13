// End-to-end HTTP benchmark, Pype vs Express: npm run bench
// Runs from the compiled build, ts-node itself would slow every server down.
import { spawn, ChildProcess } from "child_process";
import { extname, join } from "path";
import autocannon from "autocannon";
import { lookups } from "./routes";

const DURATION = Number(process.env.DURATION ?? 5);
const CONNECTIONS = 200;
// several load-generating threads, so the client isn't the bottleneck
const WORKERS = 4;

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

async function run(url: string, duration: number) {
  const result = await autocannon({
    url,
    connections: CONNECTIONS,
    duration,
    workers: WORKERS,
  });
  return { rps: result.requests.average, latency: result.latency.average, errors: result.non2xx + result.errors };
}

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
      await run(url, 1); // warm up
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
