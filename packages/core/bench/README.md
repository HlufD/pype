# Performance plan: 95% of bare Node.js

How to get Pype from about 84% to 95% of a bare Node.js `http` server, without
breaking Express 5 compatibility.

## Where we are

Measured on 2026-10-22: Apple M1 Pro (8 cores), Node v24.22.0, `npm run bench`,
5 s runs, 200 connections, 4 autocannon workers.

| | req/s | % of bare Node |
|---|---:|---:|
| bare Node.js (`server.ts node`) | 67,107 | 100% |
| Pype, 1 param (`/api/users/42`) | 56,138 | 84% |
| Express 5, same route | 38,922 | 58% |

Pype runs at 55–58k req/s on every route shape (static, params, wildcard, 404).
The router is not the bottleneck: a lookup takes 26–300 ns (`npm run bench:router`).

## The req/s ratio is the wrong yardstick

CPU profiles of both servers under the same load show **~42% idle time in both**.
Even bare Node isn't saturated: autocannon on the same laptop is the limit, so
the req/s ratio moves with client noise as much as with server cost.

The comparison isn't equal work either. The bare Node server sends no `ETag`
and an empty `params`, so its response is 193 bytes against Pype's 244.

Track **server CPU time per request** instead (user + system, from the profile or
`process.cpuUsage()`):

| | CPU µs/req | socket write | everything else |
|---|---:|---:|---:|
| bare Node.js | 8.95 | 5.51 | 3.43 |
| Pype | 12.24 | 6.94 | 5.30 |
| Pype, `etag` off | 11.91 | 7.05 | 4.86 |

- **Socket write** (`writeUtf8String`, the native write including the syscall) is
  paid by everyone. Both servers do exactly one native write per response, so
  the 1.4 µs difference here is most likely contention noise, not extra chunks.
  Confirm it with repeated runs before chasing it.
- **Everything else** is where Pype's real overhead lives: about **1.9 µs per
  request** of extra JavaScript.

At 95%, Pype may spend at most 8.95 / 0.95 = **9.42 µs per request**. If the
write gap is noise, that means cutting about **1.4 µs of the 1.9 µs** Pype adds.
That's roughly three quarters of all framework overhead, which puts 95% at the
edge of what's reachable. A realistic outcome of the steps below is 90–93%.

## Where the 1.9 µs goes

Self time per request, Pype minus bare Node, from `--cpu-prof` on `/api/users/42`:

| Area | Extra ns/req | Main frames |
|---|---:|---|
| Response headers | ~600 | `setHeader` 197, `checkInvalidHeaderChar` 158, extra `_storeHeader` 112, `hasHeader` 56, `getHeader` 39, header-name RegExp 45 |
| Dispatch | ~800 | `find` 104, `json` 99, `send` 91, `handle` 87, `prepare` 67, `next` 66 + 46, `route` 57, `runRoute` 53, `match` 52, `app.handler` 41, `pickParams` 40, `Request`/`Response` constructors |
| ETag | ~100 | `generateStrongETag` 65, plus a 42-byte header |
| GC | ~35 | 0.16 vs 0.12 µs/req |

`JSON.stringify` costs the same in both (~200–260 ns), so there's nothing to win
there without changing the serializer.

## The plan

Ordered by expected gain per unit of risk. Each step must keep the full test
suite green (`npm test`, `npm run test:fuzz`), since Express 5 behaviour is the
contract.

### 0. Fix the measurement first

Without this, gains of 100–300 ns are invisible in the noise.

- Have `server.ts` report `process.cpuUsage()` over the IPC channel next to
  memory, and print **CPU µs/req** in `http.bench.ts` beside req/s.
- Make the bare Node server do equal work: echo the same `params` object and
  send a weak ETag of the body. That gives a fair ceiling to compare against.
- Run each case 3–5 times and report the median. Use `DURATION=15` for anything
  you publish.
- Optional: run autocannon from a second machine, or pin it to fewer cores, so
  the client stops being the limit.

### 1. Dispatch state as one object: about 300–500 ns

This helps every app, not only the benchmark. For one `GET /api/users/42` with
one handler, Pype makes about 15 allocations before the handler runs:

- `handle()`: the object `prepare()` returns, the `finish`, `route`,
  `getParamCalls`, `routerDone` and `next` closures, and a context with about 15
  captured variables.
- `runRoute()`: the `leave` closure, a `once(leave)` wrapper and the
  `enterParams` callback.
- `Route.dispatch()`: another `next` closure and a `once(next)` per handler.
- A `req.params = {}` and a `req.query` that get replaced, and the params objects
  from the match and `pickParams`.

Changes:

- **Replace the closures in `handle()` with one `Dispatch` class instance**
  (`index`, `layers`, `match`, `current`, `sync`, ... with `next`, `route` and
  `finish` methods): one allocation with a stable shape.
- **Replace the `once()` wrappers** with a per-layer call counter on that object.
  The "next() called multiple times" warning stays the same.
- **Give `Route.dispatch()` the same treatment.**
- **Let `prepare()` return nothing** and keep `restore` state only for mounted apps.

### 2. Fast path when the route runs first: about 200–300 ns more

When the app isn't mounted, the request isn't OPTIONS, the path has no `%`, one
route layer matched with no router mounts or `param()` callbacks, its route has a
single handler for the method, and no non-error middleware comes before it
(trailing error handlers are fine): set `req.params` and `req.route` and call the
handler directly.

Only when the handler calls `next()`, throws or rejects, build the `Dispatch`
from step 1 and continue after this layer, so behaviour is identical, including
re-routing when the handler changed `req.url`.

Real apps usually have `app.use()` middleware ahead of their routes, so this
step mostly helps apps without it; step 1 is the one that helps everyone. It needs
tests comparing both paths: `next()` → 404, `next(err)` → error middleware, a
rejected promise, a changed `req.url`, HEAD falling back to GET, `next("route")`.

### 3. Response headers: about 150–300 ns

Node validates header names and values in both servers (in `setHeader` for Pype,
in `_storeHeader` for bare Node), so that part can't be saved. What can be:

- **`send()` reads headers several times:** `get("Content-Type")` and
  `setCharset`, then `hasHeader("Transfer-Encoding")` and `hasHeader("ETag")`.
  When `json()` set the Content-Type itself, pass that down and skip the read-back
  and the charset parse.
- **Look up `"etag fn"` and `req.fresh` only when they can matter:** `req.fresh`
  is always false without an `If-None-Match` or `If-Modified-Since` header.
- **Keep `setHeader()`.** Headers passed to `writeHead(status, headers)` in one go
  can't be read back with `res.getHeader()`, which `morgan` and code wrapping
  `writeHead` depend on.

### 4. Stable object shapes: about 50–150 ns

`prepare()` adds `app`, `res`, `originalUrl`, `baseUrl`, `params`, `query`,
`next` and `locals` to `req`/`res` after construction. Every new property is a
hidden-class transition, and a mounted app adds them in a different order.

- Declare these fields in the `Request`/`Response` constructors (with
  `undefined`), so every request object has its final shape from the moment Node
  creates it.
- Keep the order in which `prepare()` assigns fields fixed across code paths.

### 5. Lazy work: about 50–100 ns

- **Parse `req.query` lazily**, only when a handler reads it, through a getter
  that caches the result. Skip parsing entirely when the URL has no `?`.
- **Decode params lazily** (`pickParams`, `decodeParam`) when a param has no `%`.

### 6. ETag: about 100 ns, keep it on

Express 5 sends weak ETags by default, so Pype keeps doing that. The small-body
cache already turns the hash into a map lookup. Two remaining options:

- Measure whether the cache lookup beats a direct hash for bodies under 64 bytes.
  For tiny JSON, `crypto.hash("sha1", ...)` may be as fast as building the key.
- Document `app.set("etag", false)` for APIs that don't need conditional GETs.
  It saves ~0.3 µs and 42 bytes per response.

## Expected outcome

| After step | CPU µs/req (est.) | % of bare Node (est.) |
|---|---:|---:|
| today | 12.2 (5.3 excluding writes) | ~84% req/s, 73% CPU |
| 1–3 | 4.3–4.7 excluding writes | ~89–91% |
| 1–6 | 4.0–4.5 excluding writes | ~91–94% |

These are estimates from profile self times. Re-measure after each step with the
method from step 0, and update the table.

## How to profile

```sh
cd packages/core
npx tsc
NODE_ENV=production node --cpu-prof --cpu-prof-dir=prof .build/bench/server.js pype 4111 &
npx autocannon -c 200 -d 6 -w 4 http://127.0.0.1:4111/api/users/42
kill -INT %1    # server.ts exits on SIGINT so the profile gets written
```

Open `prof/*.cpuprofile` in Chrome DevTools (Performance tab → Load profile), or
sum self time per frame with a short script. Divide by the request count from
autocannon to get ns per request, and always profile bare Node the same way to
compare.
