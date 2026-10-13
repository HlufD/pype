/**
 * Router-only microbenchmark: `npm run bench:router`.
 *
 * Set `ROUTER_MODULE` to a file exporting another `RouteNode` to compare
 * implementations. Each lookup is warmed up before it is measured.
 *
 * @packageDocumentation
 */
import { RouteNode } from "../src/utils/Trie-Route";
import { HTTP_METHODS } from "../src/enums/methods.enum";
import { lookups, routes } from "./routes";

/** The router implementation under test. */
const RouterClass = process.env.ROUTER_MODULE
  ? (require(process.env.ROUTER_MODULE).RouteNode as typeof RouteNode)
  : RouteNode;

const router = new RouterClass({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
for (const [method, path] of routes) router.register(path, method as HTTP_METHODS, [() => {}]);

/** Lookups measured per route. */
const ITERATIONS = 3_000_000;

for (const [name, url] of Object.entries(lookups)) {
  for (let i = 0; i < 200_000; i++) router.match(url, HTTP_METHODS.GET);

  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) router.match(url, HTTP_METHODS.GET);
  const ns = Number(process.hrtime.bigint() - start);

  const opsPerSec = (ITERATIONS / ns) * 1e9;
  console.log(`${name.padEnd(46)} ${(opsPerSec / 1e6).toFixed(2).padStart(7)}M ops/s  ${(ns / ITERATIONS).toFixed(0).padStart(5)} ns/op`);
}
