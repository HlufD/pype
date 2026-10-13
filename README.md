# pype-router

[![CI](https://github.com/HlufD/pipe-router/actions/workflows/ci.yml/badge.svg)](https://github.com/HlufD/pipe-router/actions/workflows/ci.yml)

An Express 5 compatible web framework for Node.js, written in TypeScript, with
a radix tree router and no runtime dependencies.

- **Express compatible**: the Express 5 request and response API, error
  middleware, `next("route")`, routers and settings. Express middleware from
  npm (`cors`, `helmet`, `morgan`, `express-session`, `multer`, ...) works
  unchanged.
- **Fast**: 1.35–1.5× the throughput of Express 5 in the bundled benchmark,
  about 85–90% of a bare Node.js `http` server.
- **Typed**: written in TypeScript, ships its own declarations, and picks up
  type augmentations written for Express (for example passport's `req.user`).

```sh
npm install pype-router
```

Requires Node.js 22 or later.

## Quick start

```ts
import { ErrorMiddleware, Pype, PypeRouter, json } from "pype-router";

const app = new Pype();
const api = new PypeRouter();

app.use(json());

api.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

api.post("/users", (req, res) => {
  res.status(201).json(req.body);
});

app.use("/api", api);

const onError: ErrorMiddleware = (err, req, res, next) => {
  res.status(err.status ?? 500).json({ error: err.message });
};
app.use(onError);

app.listen(3000, () => console.log("listening on :3000"));
```

A complete example with logging, a JSON 404 and graceful shutdown is in
[`examples/app.ts`](examples/app.ts) (`npm run dev`).

## Using Express middleware

Anything written for Express 5 can be passed to `app.use()` or a route:

```ts
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import session from "express-session";

app.use(helmet(), cors(), morgan("combined"), cookieParser("secret"));
app.use(session({ secret: "secret", resave: false, saveUninitialized: false }));
```

The test suite runs against `cors`, `helmet`, `morgan`, `cookie-parser`,
`compression`, `express-session`, `express-rate-limit`, `body-parser`,
`serve-static` and `multer`.

## Routing

```ts
app.get("/", handler);
app.post("/users", validate, create);           // several handlers
app.get("/users/:id?", show);                    // optional last param
app.get("/files/*", serve);                      // req.params["*"] is the rest
app.all("/health", health);                      // every method
app.route("/books").get(list).post(create);      // chained

const admin = new PypeRouter();
admin.use(requireAdmin);                         // router-level middleware
admin.get("/stats", stats);
app.use("/admin", admin);                        // req.baseUrl is "/admin"
```

- Middleware, routes and error handlers run in the order they are registered.
- `next()` continues, `next(err)` jumps to error middleware (handlers with four
  parameters), `next("route")` skips the rest of a route, `next("router")`
  leaves a router.
- Errors thrown in handlers and rejected promises are passed to `next(err)`.
- As with Express, TypeScript can't infer the parameters of an inline error
  handler. Type it as `ErrorMiddleware` or annotate the parameters.
- Params are URL-decoded. `HEAD` requests use `GET` routes.
- Duplicate and trailing slashes are ignored, for routes and for path-scoped
  middleware alike.

## API

**Application**: `use`, `get`/`post`/`put`/`patch`/`delete`/`head`/`options`/`all`,
`route`, `listen(port, [hostname], [callback])`, `set`, `get(setting)`,
`enable`, `disable`, `enabled`, `disabled`, `locals`, and `handler` for
`http.createServer(app.handler)` or `supertest`.

**Request**: `params`, `query`, `body`, `path`, `originalUrl`, `baseUrl`,
`route`, `get`/`header`, `accepts`, `acceptsCharsets`, `acceptsEncodings`,
`acceptsLanguages`, `is`, `range`, `protocol`, `secure`, `ip`, `ips`, `host`,
`hostname`, `subdomains`, `xhr`, `fresh`, `stale`, `app`, `res`.

**Response**: `status`, `send`, `json`, `sendStatus`, `sendFile`, `download`,
`attachment`, `redirect`, `location`, `links`, `set`/`header`, `get`,
`append`, `type`, `vary`, `format`, `cookie`, `clearCookie`, `locals`, `app`.

**Body parsers**: `json()`, `urlencoded()`, `text()` and `raw()`, with
`limit` (default `"100kb"`) and `type` options. Errors are passed to
`next(err)` with a `status` of 400, 413 or 415, like `body-parser`.

**Settings**: `"trust proxy"` (same values as Express: `true`, a hop count,
`"loopback"`, IPs, CIDRs or a function), `"etag"`, `"json spaces"`,
`"json replacer"`, `"subdomain offset"` and `"env"`.

Every public method has TSDoc, so editors show the details inline.

## Differences from Express

- When several route patterns match a URL, the most specific wins (static,
  then `:param`, then `*`) instead of the first registered. Routes with the
  same method and path still run in registration order.
- Not implemented: `app.param()`, regular expression routes, patterns inside
  a segment such as `/:from-:to`, mounting another app with
  `app.use(otherApp)`, `res.render()`, `res.jsonp()`, the
  `"case sensitive routing"` and `"strict routing"` settings, and a built-in
  static file middleware (`serve-static` works, `res.sendFile` is built in).
- The default 404 and 500 responses are JSON, for example
  `{"error":"Cannot GET /nope","status":404}`.
- Body parsers don't decompress bodies (415) and `urlencoded()` doesn't parse
  nested `a[b]=c` keys.

## Production notes

- **Proxies**: leave `"trust proxy"` off unless the app is behind a proxy you
  control, and then trust only that proxy, for example
  `app.set("trust proxy", "loopback")`. It decides `req.ip`, `req.protocol` and
  `req.hostname`.
- **Body size**: the body parsers reject bodies over `limit` with 413.
- **Files**: use `res.sendFile(path, { root })` for user-supplied paths. Paths
  escaping the root are rejected with 403, dotfiles are hidden by default, and
  the file is closed when the client disconnects.
- **Errors**: the default error handler only exposes the messages of 4xx
  errors to clients, and logs every error with `console.error` unless `env` is
  `"test"`. Register your own error middleware to log elsewhere.
- **Shutdown**: `listen()` returns the `http.Server`, so you can call
  `server.close()` on `SIGTERM`.

## Performance

`npm run bench` load-tests a bare Node.js server, Pype and Express 5 with the
same 60 routes. On a 14-core Linux machine with Node 24:

| Route                 | Pype req/s | Express req/s | Speedup |
| --------------------- | ---------- | ------------- | ------- |
| static                | 27,840     | 20,611        | 1.35×   |
| static, last of 60    | 28,600     | 19,331        | 1.48×   |
| 1 param               | 28,941     | 20,187        | 1.43×   |
| 3 params              | 26,965     | 18,133        | 1.49×   |
| wildcard              | 24,901     | 16,390        | 1.52×   |
| not found             | 25,187     | 17,606        | 1.43×   |

A bare Node.js server reached 32,081 req/s on the same machine. Numbers vary
by about ±10% between runs, measure on your own hardware before relying on
them. `npm run bench:router` measures route lookups alone.

## Development

```sh
npm run dev            # example app with reload
npm test               # all tests
npm run test:coverage  # tests with coverage thresholds
npm run test:fuzz      # property-based fuzzing, 20,000 runs per property
npm run typecheck
npm run build          # dist/ with declarations
```

## License

[ISC](LICENSE)
