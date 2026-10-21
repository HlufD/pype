# Pype

[![CI](https://github.com/HlufD/pipe-router/actions/workflows/ci.yml/badge.svg)](https://github.com/HlufD/pipe-router/actions/workflows/ci.yml)

An Express 5 compatible web framework for Node.js, written in TypeScript, with
a radix tree router and no runtime dependencies.

- **Express compatible**: the Express 5 request and response API, error
  middleware, `next("route")`, routers and settings. Express middleware from
  npm (`cors`, `helmet`, `morgan`, `express-session`, `multer`, ...) works
  unchanged.
- **Fast**: about 1.3–1.5× the throughput of Express 5 in the bundled
  benchmark, and 85–90% of a bare Node.js `http` server.
- **Typed**: written in TypeScript, ships its own declarations, and picks up
  type augmentations written for Express (for example passport's `req.user`).
- **Checked against Express**: a differential test suite sends the same
  requests, including fuzzed headers and bodies, to Express 5 and to Pype and
  compares status, headers and body. The [known differences](#migrating-from-express)
  are listed below.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
  - [The request pipeline](#the-request-pipeline)
  - [Route paths](#route-paths)
  - [Mounting and relative paths](#mounting-and-relative-paths)
  - [Error handling](#error-handling)
- [API reference](#api-reference)
  - [Pype (application)](#pype-application)
  - [PypeRouter](#pyperouter)
  - [Request](#request)
  - [Response](#response)
  - [Body parsers](#body-parsers)
  - [Settings](#settings)
  - [TypeScript types](#typescript-types)
- [Using Express middleware](#using-express-middleware)
- [Recipes](#recipes)
- [Migrating from Express](#migrating-from-express)
- [Production notes](#production-notes)
- [Performance](#performance)
- [Development](#development)
- [License](#license)

## Installation

```sh
npm install pyper-web
```

Requires Node.js 22 or later. Works from CommonJS (`require`), ES modules
(`import`) and TypeScript.

## Quick start

```ts
import { ErrorMiddleware, Pype, PypeRouter, json } from "pyper-web";

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

```sh
curl localhost:3000/api/users/42
# {"id":"42"}
```

## Core concepts

### The request pipeline

Everything registered with `app.use()`, `app.get()` and the other route
methods forms one pipeline. For each request, Pype walks it **in registration
order**:

- **Middleware** registered with `use()` runs when the request path is the
  mount path or below it.
- **Routes** run when the method and path match.
- **Error middleware** (functions with four parameters) runs only after an
  error.

Each step decides what happens next:

| Call              | Effect                                                         |
| ----------------- | -------------------------------------------------------------- |
| `next()`          | Continue with the next matching middleware or route            |
| `next(err)`       | Skip to the next error middleware                              |
| `next("route")`   | Skip the remaining handlers of the current route               |
| `next("router")`  | Skip the remaining middleware and routes of the current router |
| _send a response_ | Stop; later steps don't run unless you call `next()`           |

If nothing responds, Pype sends `404` with
`{"error":"Cannot GET /path","status":404}`.

```ts
app.use((req, res, next) => {
  console.log(req.method, req.path);
  next();
});

app.get("/users/:id", loadUser, (req, res) => {
  res.json(res.locals.user);
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});
```

Calling `next()` twice from the same handler only logs a warning; the second
call is ignored. Express runs the following layer again instead, which
usually ends in a "headers already sent" error. If the second call passes an
error, the warning includes it, so it still shows up in your logs.

### Route paths

| Pattern             | Matches                                  | `req.params`                    |
| ------------------- | ---------------------------------------- | ------------------------------- |
| `/users`            | `/users`, `/users/`                      | `{}`                            |
| `/users/:id`        | `/users/42`                              | `{ id: "42" }`                  |
| `/users/:id/posts`  | `/users/42/posts`                        | `{ id: "42" }`                  |
| `/users/:id?`       | `/users` and `/users/42`                 | `{}` or `{ id: "42" }`          |
| `/files/*`          | `/files/a/b.txt`                         | `{ "*": "a/b.txt" }`            |
| `/`                 | `/`                                      | `{}`                            |
| `/^\/re\/(\d+)$/`    | `/re/42`                                 | `{ 0: "42" }`                   |
| `/(?<name>\w+)-(\d+)/` | `/x/abc-12`                            | `{ name: "abc", 0: "12" }`      |
| `["/a", "/b/:id"]`  | `/a` and `/b/7`                          | `{}` or `{ id: "7" }`           |

Rules:

- Paths must start with `/`. An optional parameter (`:name?`) and the
  wildcard (`*`) are only allowed at the end. A `:param` always takes a whole
  segment, and its name is made of letters, digits, `_` and `$` and doesn't
  start with a digit. Other forms, like `/:from-:to`, `/a-:id` or `/:`, throw
  when the route is registered.
- Matching is case-sensitive by default. Turn it off with
  `app.set("case sensitive routing", false)` to match like Express does by
  default: `/Users/:id` then matches `/users/Ada`, and the param keeps its
  case (`"Ada"`). Only the path text is compared ignoring case; RegExp paths
  follow their own `i` flag.
- Duplicate slashes and a trailing slash are ignored: `//users//42/` matches
  `/users/:id`.
- Parameter values are URL-decoded (`/users/a%20b` gives `"a b"`). A value
  with a malformed escape (`/users/%ZZ`) skips the route and passes a 400
  error (`Failed to decode param '%ZZ'`) to the next error middleware, like
  Express.
- When several patterns match, the most specific wins: a static segment beats
  a `:param`, which beats `*`. If a more specific branch fails further down,
  the router backtracks, so with `/users/new` and `/users/:id/edit`
  registered, `/users/new/edit` still reaches the second route.
- The same method and path may be registered more than once; the routes run
  in registration order, which is what `next("route")` is for.
- `HEAD` requests use `GET` routes when no `HEAD` route exists. The body is
  not sent.
- Two routes may not use different parameter names at the same position,
  such as `/a/:id` and `/a/:userId/x`. This is reported by `listen()`, or by
  the first request when you use `app.handler`.
- A regular expression path is matched like in Express: against the path as
  it is (no slash normalization), in registration order with the other
  layers. Named groups become params with their name, other groups are
  numbered from `0`, and values are URL-decoded. `req.route.path` is the
  RegExp.
- An array of paths is one route (or middleware) that matches any of them and
  runs at most once per request; `req.route.path` is the array.
- Route patterns are Express 4 style (`:id?`, `*`), not Express 5's `{/:id}`
  and `/*splat`.

### Mounting and relative paths

Middleware and routers mounted on a path see the request path relative to
that mount point, like in Express:

```ts
const admin = new PypeRouter();

admin.get("/stats", (req, res) => {
  req.baseUrl;     // "/admin"
  req.path;        // "/stats"
  req.url;         // "/stats?range=7d"
  req.originalUrl; // "/admin/stats?range=7d"
  req.route;       // { path: "/stats", method: "get" }
});

app.use("/admin", admin);
```

`use("/admin", ...)` matches `/admin` and everything below it, but not
`/administrator`. The original values are restored when the middleware calls
`next()`.

### Error handling

Errors reach error middleware in three ways:

```ts
app.get("/sync", () => {
  throw new Error("boom");                 // thrown synchronously
});

app.get("/async", async () => {
  await somethingThatRejects();            // rejected promise
});

app.get("/explicit", (req, res, next) => {
  next(new Error("boom"));                 // passed to next()
});
```

A four-parameter handler inside a route only gets errors raised in that
route; an error that is already pending skips routes entirely, like in
Express.

Error middleware has exactly four parameters and is usually registered last:

```ts
import { ErrorMiddleware } from "pyper-web";

const onError: ErrorMiddleware = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status ?? 500).json({ error: err.message });
};

app.use(onError);
```

TypeScript can't infer the parameter types of an inline four-parameter
function passed to `use()` (the same is true for Express), so type it as
`ErrorMiddleware` as above, or annotate the parameters.

If no error middleware handles an error, the built-in final handler responds:

- The status is `err.status` or `err.statusCode` when it is between 400 and
  599, otherwise 500.
- The body is `{"error": message, "status": status}`. The error's own message
  is only used for 4xx errors whose `expose` property isn't `false`; other
  errors get the standard status text, so internals don't leak.
- `err.headers`, if present, are added to the response.
- The error is logged with `console.error` unless the `env` setting is
  `"test"`.
- If the response has already started, the connection is closed instead.

## API reference

### Pype (application)

```ts
import { Pype } from "pyper-web";

const app = new Pype();
const app = new Pype({ "trust proxy": "loopback", "json spaces": 2 });
```

`new Pype(settings?)` creates an application. `settings` is an optional
object of [settings](#settings).

#### Properties

| Property   | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `settings` | All settings by name.                                            |
| `locals`   | An object for values shared across the app, like `app.locals` in Express. |
| `handler`  | A `(req, res) => void` request listener for `http.createServer` or test tools. |

#### `app.listen(port, [hostname], [callback])`

Starts an HTTP server and returns the Node.js `http.Server`.

```ts
const server = app.listen(3000);
app.listen(3000, () => console.log("ready"));
app.listen(3000, "127.0.0.1", () => console.log("local only"));
```

`port` `0` picks a free port. Throws if routes conflict (see
[Route paths](#route-paths)).

#### `app.handler`

A request listener, for running Pype on your own server, HTTPS, or in tests:

```ts
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";

createServer(app.handler).listen(3000);
createHttpsServer({ key, cert }, app.handler).listen(443);
```

#### `app.use([path], ...handlers)`

Adds middleware, error middleware or routers. Without a path they run for
every request; with a path, for that path and everything below it.

```ts
app.use(logger);
app.use(cors(), helmet());              // several at once
app.use([auth, audit]);                 // arrays are flattened
app.use("/api", apiRouter);             // mount a router
app.use("/static", serveStatic("public"));
app.use(["/a", "/b"], audit);           // several mount paths, runs once
app.use(/^\/v(\d+)/, version);          // RegExp mount path, req.params[0] is the version
app.use(onError);                       // four parameters: error middleware
```

A mount path can have params, like `app.use("/orgs/:org", tenant)`: each
matches one path segment, the middleware gets them in `req.params` (and runs
`param()` callbacks), and `req.baseUrl` is the matched part, `/orgs/acme`.

A RegExp mount path must match at the start of the path and end at a `/` or
the end of it, like in Express; the matched part becomes `req.baseUrl` and its
groups `req.params` (and run `param()` callbacks). Mounting a router on a
RegExp throws a `TypeError`: Pype resolves mount paths when routes are
compiled.

Throws a `TypeError` if a handler isn't a function or a `PypeRouter`.

#### `app.get(path, ...handlers)`, `post`, `put`, `patch`, `delete`, `head`, `options`, `all`

Adds a route for one HTTP method, or for every method with `all()`. Handlers
can be functions or arrays of functions and run in order.

```ts
app.get("/users", list);
app.post("/users", validate, create);
app.put("/users/:id", [auth, validate], update);
app.all("/health", (req, res) => res.sendStatus(200));
```

With a single argument, `app.get(name)` reads a setting instead:
`app.get("env")`.

An `OPTIONS` request that no handler answers gets an automatic response, like
in Express: 200 with an `Allow` header (and body) listing the methods of the
routes for that path, `HEAD` included when there is a `GET` route. Each
router answers for its own routes when it is done with the request, so a
mounted router answers before middleware registered after it, such as a
catch-all 404. Routes that handle `OPTIONS` themselves, including `all()`
routes, aren't listed; without any other route the request gets the usual
404.

#### `app.route(path)`

Returns a chainable builder for one path:

```ts
app.route("/books")
  .get(list)
  .post(create);
```

The builder has `get`, `post`, `put`, `patch`, `delete`, `head`, `options` and
`all`. The path can also be a RegExp or an array.

#### `app.param(name, callback)`, `router.param(name, callback)`

Runs `callback(req, res, next, value, name)` before the handlers of routes
that have the parameter, like Express. `name` can be an array.

```ts
app.param("id", async (req, res, next, id) => {
  req.user = await users.find(id);
  if (!req.user) return next(Object.assign(new Error("No such user"), { status: 404 }));
  next();
});

app.get("/users/:id", (req, res) => res.json(req.user));
app.get("/users/:id/posts", (req, res) => res.json(req.user.posts));
```

- Callbacks run once per request and value: a second route with the same `id`
  reuses the result (and the error, unless it was `next("route")`).
- `next(err)`, a thrown error or a rejected promise go to error middleware;
  `next("route")` skips the route.
- Each router has its own callbacks: `app.param()` applies to the app's own
  routes, `router.param()` to the router's.
- Changes to `req.params[name]` in a callback are kept for the route.

#### `app.engine(ext, callback)`, `app.render(view, [locals], callback)`

Template rendering works like in Express, with the same engine interface:
`callback(path, options, done)`. Engines made for Express (`ejs`, `pug`,
`handlebars` adapters, ...) work as they are.

```ts
app.engine("html", require("ejs").renderFile);
app.set("views", "./templates");        // a directory, or a list searched in order
app.set("view engine", "html");          // extension for names without one

app.get("/", (req, res) => res.render("home", { title: "Hi" }));
```

- A view is looked up in each `"views"` directory as `<name>.<ext>`, then
  `<name>/index.<ext>`. Without a registered engine the npm module named
  after the extension is loaded (`require("pug").__express`).
- The template gets `app.locals` (including `settings`), then `res.locals`,
  then the options passed to `render()`.
- With `"view cache"` (on when `env` is `"production"`), or `cache: true` in
  the options, found views are remembered by name.
- `app.render()` calls back with `(err, html)`, always asynchronously. A view
  that can't be found is an error like `Failed to lookup view "home" in views
  directory "/app/views"`.
- `app.set("view", MyView)` replaces the view class, with Express's `View`
  interface.

#### `app.set(name, value)`, `app.get(name)`

Writes and reads [settings](#settings). `set` returns the app, so calls can be
chained.

```ts
app.set("trust proxy", 1).set("json spaces", 2);
app.get("trust proxy"); // 1
```

#### `app.enable(name)`, `app.disable(name)`, `app.enabled(name)`, `app.disabled(name)`

Shorthands for setting a setting to `true` or `false`, and for checking
whether it is truthy or falsy.

### PypeRouter

A router groups middleware and routes so they can be mounted on a path.

```ts
import { PypeRouter } from "pyper-web";

const users = new PypeRouter();

users.use(requireLogin);                    // runs for every request under the mount path
users.get("/", list);
users.get("/:id", show);
users.route("/:id/avatar").get(getAvatar).put(setAvatar);

app.use("/users", users);
```

A router has the same `use`, `get`, `post`, `put`, `patch`, `delete`, `head`,
`options`, `all` and `route` methods as the app, with the same behaviour.
Routers can be nested, for example `api.use("/users", users)` and then
`app.use("/api", api)`.

Mount paths can have params. Like in Express, a router only sees the params
of its own paths in `req.params`; create it with `mergeParams: true` to keep
the ones of the path it is mounted on too:

```ts
const teams = new PypeRouter({ mergeParams: true });
teams.get("/:team", (req, res) => {
  req.params; // { org: "acme", team: "red" }, only { team: "red" } without mergeParams
});
app.use("/orgs/:org", teams);
```

`param()` callbacks run for the params of the paths registered on their own
router: `app.param("org", ...)` runs for `app.use("/orgs/:org", teams)`,
before the router's callbacks.

`next("router")` inside a router skips the rest of that router and continues
after it.

Routes and middleware added to a router after it was mounted are picked up
automatically.

### Request

`req` extends Node's `http.IncomingMessage`, so `req.method`, `req.headers`,
`req.url`, `req.socket` and the stream API are available too.

#### Properties

| Property        | Type                                  | Description |
| --------------- | ------------------------------------- | ----------- |
| `params`        | `Record<string, string>`              | Route parameters, URL-decoded. `"*"` holds the wildcard match. |
| `query`         | `Record<string, any>`                 | Parsed with the [`"query parser"` setting](#settings). By default Node's `querystring.parse`, like Express 5: repeated keys become arrays, at most 1000 keys are read and `a[b]=c` stays a literal key; with `"extended"`, nested objects and arrays. The object has no prototype, so use `Object.hasOwn(req.query, key)` rather than `req.query.hasOwnProperty(key)`. |
| `body`          | `any`                                 | Parsed body, set by a [body parser](#body-parsers). `undefined` otherwise. |
| `path`          | `string`                              | Path without the query string, relative to the current mount path. |
| `originalUrl`   | `string`                              | The full original URL, including the query string. |
| `baseUrl`       | `string`                              | Path the current router or middleware is mounted on. |
| `route`         | `{ path, method }`                    | The matched route, while its handlers run. |
| `cookies`       | `Record<string, any>`                 | Set by `cookie-parser`; `undefined` without it. |
| `signedCookies` | `Record<string, any>`                 | Set by `cookie-parser`. |
| `protocol`      | `string`                              | `"http"` or `"https"`. Uses `X-Forwarded-Proto` when the proxy is trusted. |
| `secure`        | `boolean`                             | `true` for HTTPS. |
| `ip`            | `string \| undefined`                 | Client address. Uses `X-Forwarded-For` as far as proxies are trusted. |
| `ips`           | `string[]`                            | Trusted `X-Forwarded-For` addresses, client first. Empty unless a proxy is trusted. |
| `host`          | `string \| undefined`                 | `Host` header including the port. Uses `X-Forwarded-Host` when the proxy is trusted. |
| `hostname`      | `string \| undefined`                 | `host` without the port. IPv6 addresses keep their brackets: `[::1]`. |
| `subdomains`    | `string[]`                            | Subdomains in reverse order: `["shop", "api"]` for `api.shop.example.com`. Empty for IP addresses. |
| `xhr`           | `boolean`                             | `true` when `X-Requested-With` is `XMLHttpRequest`. |
| `fresh`         | `boolean`                             | `true` when the client's cached copy is still valid (`If-None-Match` / `If-Modified-Since`). |
| `stale`         | `boolean`                             | Opposite of `fresh`. |
| `app`           | `Pype`                                | The application. |
| `res`           | `Response`                            | The response for this request. |

See [`"trust proxy"`](#settings) for how `ip`, `ips`, `protocol` and `host`
decide whether to trust forwarded headers.

#### `req.get(name)`, `req.header(name)`

Returns a request header, case-insensitively. `Referer` and `Referrer` are
interchangeable.

```ts
req.get("Content-Type"); // "application/json"
```

#### `req.accepts(...types)`

Picks the best type for the `Accept` header with the rules of Express's
`negotiator`: q-values first, then the most specific match (`text/html`
beats `text/*` beats `*/*`, and media type parameters like `level=1` must
match), then the client's order. Types can be extensions (`"json"`) or MIME
types (`"text/html"`), and are returned as you passed them; unknown
extensions never match.

```ts
// Accept: text/html, application/json;q=0.5
req.accepts("json", "html");     // "html"
req.accepts(["json", "html"]);   // arrays work too
req.accepts("png");              // false
req.accepts();                   // ["text/html", "application/json"]
```

Without an `Accept` header, the first type is returned. Without arguments,
the accepted types are listed as the client wrote them, most preferred
first.

#### `req.acceptsCharsets(...)`, `req.acceptsEncodings(...)`, `req.acceptsLanguages(...)`

Same as `accepts()` for `Accept-Charset`, `Accept-Encoding` and
`Accept-Language`.

- `"identity"` encoding is acceptable unless the client refuses it, with
  `identity;q=0` or `*;q=0`. Without an `Accept-Encoding` header it is the only
  acceptable encoding, so `req.acceptsEncodings("gzip")` is `false`.
- An `"en"` preference matches an `"en-US"` offer and the other way round, but
  `"en-GB"` doesn't match `"en-US"`.

```ts
// Accept-Language: en, fr;q=0.5
req.acceptsLanguages("fr", "en-US"); // "en-US"
```

#### `req.is(...types)`

Checks the request's `Content-Type`, like Express's `type-is`. Returns the
first matching type as you passed it, or the request's actual type for
patterns with `*` or a leading `+`. Returns `false` when none matches or the
`Content-Type` is missing or invalid, and `null` when the request has no body
(neither `Content-Length` nor `Transfer-Encoding`; `Content-Length: 0` counts
as a body).

```ts
// Content-Type: application/json; charset=utf-8
req.is("json");                 // "json"
req.is("text/*", "json");       // "json"
req.is("application/*");        // "application/json"
req.is("+json");                // false: only types ending in +json, e.g. application/vnd.api+json
req.is("html");                 // false
req.is();                       // "application/json"
```

`"urlencoded"` and `"multipart"` are shorthands for
`application/x-www-form-urlencoded` and `multipart/*`.

#### `req.range(size, [options])`

Parses the `Range` header for a resource of `size` bytes.

```ts
// Range: bytes=0-99, 200-
req.range(1000);                    // [{ start: 0, end: 99 }, { start: 200, end: 999 }], with type "bytes"
req.range(1000, { combine: true }); // merges overlapping and adjacent ranges
```

Returns `undefined` without a `Range` header, `-1` when the range can't be
satisfied and `-2` when the header is malformed. Like Express, one malformed
range (`bytes=0-1,x`) makes the whole header malformed, while ranges that
can't be satisfied are skipped.

### Response

`res` extends Node's `http.ServerResponse`, so `res.statusCode`,
`res.setHeader()`, `res.write()`, `res.end()` and `res.headersSent` are
available too. Methods that don't send the response return `res`, so they can
be chained.

#### Properties

| Property | Description |
| -------- | ----------- |
| `locals` | An object for values scoped to this request, e.g. data loaded by earlier middleware. |
| `app`    | The application. |
| `req`    | The request. |

#### `res.status(code)`

Sets the status code. Throws a `TypeError` for non-integers and a
`RangeError` outside 100–999.

```ts
res.status(201).json(created);
```

#### `res.send([body])`

Sends the response.

| `body`                              | Sent as                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `string`                            | `text/html`, or the `Content-Type` already set, with `charset=utf-8` |
| `Buffer`, typed array               | `application/octet-stream` unless `Content-Type` is set       |
| object, array, number, boolean      | JSON, same as `res.json()`                                    |
| `null`, `undefined`                 | Empty body                                                    |

It also:

- sets `Content-Length`;
- adds a weak `ETag` unless the `etag` setting is `false` or an `ETag` is
  already set. Hashing the body takes about 0.4 ms per MB (`npm run
  bench:etag`), so consider turning the setting off for very large bodies;
- answers `304 Not Modified` when the client's cached copy is fresh;
- sends no body for `HEAD` requests and for 204, 205 and 304 responses.

Calling `send()` after the response has ended does nothing.

```ts
res.send("<p>Hello</p>");
res.send({ ok: true });
res.status(404).send("Not found");
```

`res.send(404)` sends `404` as a JSON body with status 200, as in Express 5.
Use `res.sendStatus(404)` to send a status.

#### `res.json(value)`

Sends any JSON value with `Content-Type: application/json; charset=utf-8`,
using the `"json replacer"` and `"json spaces"` settings.

```ts
res.json({ users });
res.json([1, 2, 3]);
res.json("a string");
```

#### `res.sendStatus(code)`

Sets the status and sends its standard text as a plain-text body.

```ts
res.sendStatus(204); // no body
res.sendStatus(403); // "Forbidden"
```

#### `res.set(name, value)`, `res.set(headers)`, `res.header(...)`

Sets one header or several. Values may be arrays. `Content-Type` values get a
`charset=utf-8` for text and JSON types.

```ts
res.set("Cache-Control", "no-store");
res.set({ "X-Request-Id": id, "X-Frame-Options": "DENY" });
res.set("Content-Type", "text/plain"); // "text/plain; charset=utf-8"
```

Throws when `value` is missing for a single header, or when `Content-Type` is
given an array.

#### `res.get(name)`

Returns a response header that has been set.

#### `res.append(name, value)`

Adds values to a header, keeping existing ones.

```ts
res.append("Set-Cookie", "a=1").append("Set-Cookie", ["b=2", "c=3"]);
```

#### `res.type(type)`

Sets `Content-Type` from an extension or a MIME type. Unknown extensions
become `application/octet-stream`.

```ts
res.type("json");        // application/json; charset=utf-8
res.type(".html");       // text/html; charset=utf-8
res.type("image/png");
```

#### `res.vary(field)`

Adds fields to the `Vary` header without duplicates, like Express: fields are
compared case-insensitively, the first spelling is kept, and `*` replaces
everything. Takes a comma-separated string or an array, and throws a
`TypeError` for an invalid header name.

```ts
res.vary("Accept").vary("origin, accept"); // Vary: Accept, origin
res.vary(["Accept", "Cookie"]);
```

#### `res.location(url)`, `res.redirect([status], url)`

`location` sets the `Location` header. `redirect` sets it and sends the
response, with status 302 unless you pass one. URLs are percent-encoded, and
already-encoded characters are left alone.

```ts
res.redirect("/login");
res.redirect(301, "https://example.com/new-home");
res.status(201).location(`/users/${id}`).json(user);
```

The redirect body is plain text (`Found. Redirecting to /login`) or the same
sentence as HTML depending on the `Accept` header, and is omitted for `HEAD`
requests. `redirect` throws if no URL is given.

#### `res.links(links)`

Appends to the `Link` header.

```ts
res.links({ next: "/users?page=3", prev: "/users?page=1" });
// Link: </users?page=3>; rel="next", </users?page=1>; rel="prev"
```

#### `res.format(handlers)`

Runs the handler that best matches the `Accept` header with
`(req, res, next)`, sets `Content-Type` and adds `Vary: Accept`. Keys can be
extensions or MIME types. Without a match, `default` runs; without `default`,
a 406 error whose `types` lists the offered MIME types is passed to
`next(err)`, like Express.

```ts
res.format({
  json: () => res.json(user),
  html: () => res.send(`<h1>${user.name}</h1>`),
  default: () => res.status(406).send("Not Acceptable"),
});
```

#### `res.cookie(name, value, [options])`

Sets a cookie. Objects are stored as `j:` followed by JSON, which
`cookie-parser` turns back into objects.

```ts
res.cookie("theme", "dark", { maxAge: 30 * 24 * 3600_000, httpOnly: true });
res.cookie("cart", { items: [1, 2] });
res.cookie("session", id, { signed: true, secure: true, sameSite: "lax" });
```

| Option        | Description |
| ------------- | ----------- |
| `maxAge`      | Lifetime in milliseconds. Sets `Max-Age` and `Expires`. |
| `expires`     | Expiry `Date`. |
| `httpOnly`    | Hide the cookie from client-side JavaScript. |
| `secure`      | Only send over HTTPS. |
| `sameSite`    | `"strict"`, `"lax"`, `"none"` (any case), or `true` for `Strict`. |
| `domain`      | Domain the cookie is sent to. |
| `path`        | Path the cookie is sent for. Defaults to `/`. |
| `signed`      | Sign the value with the secret given to `cookie-parser`. |
| `priority`    | `"low"`, `"medium"` or `"high"` (any case). |
| `partitioned` | Adds the `Partitioned` attribute. |
| `encode`      | Function used to encode the value. Defaults to `encodeURIComponent`. |

Throws a `TypeError` when the name, encoded value, `domain` or `path`
contains characters that aren't allowed in a cookie (such as `;`), when
`maxAge` isn't finite, `expires` is an invalid date, or `sameSite` or
`priority` isn't one of the values above, and an `Error` when
`signed` is used without `cookie-parser`'s secret.

#### `res.clearCookie(name, [options])`

Expires a cookie. Pass the same `path` and `domain` it was set with.

#### `res.attachment([filename])`

Marks the response as a download (`Content-Disposition: attachment`). With a
file name, also sets `Content-Type` from its extension. The header is built
like the `content-disposition` package: plain names stay as they are
(`filename=report.pdf`), others are quoted, and names with non-ASCII
characters get an ASCII fallback plus an RFC 5987 `filename*`.

```ts
res.attachment("report.pdf").send(pdfBuffer);
```

#### `res.render(view, [locals], [callback])`

Renders a view (see [`app.engine()`](#appengineext-callback-apprenderview-locals-callback))
with `res.locals` and `locals`, and sends the HTML. Errors go to
`next(err)`. With a callback, it gets `(err, html)` and nothing is sent.

```ts
res.render("users/show", { user });
res.render("email", { user }, (err, html) => sendMail(html));
```

#### `res.sendFile(path, [options], [callback])`

Streams a file.

```ts
app.get("/files/*", (req, res) => {
  res.sendFile(req.params["*"], { root: "/srv/public", maxAge: 3600_000 });
});

res.sendFile("/srv/reports/q3.pdf", (err) => {
  if (err) console.error("transfer failed", err);
});
```

- Without `root`, `path` must be absolute, otherwise a `TypeError` is thrown.
- With `root`, `path` is resolved inside it. Paths containing `..` or
  resolving outside `root` get 403, and paths with a null byte get 400.
  Always use `root` for paths that come from the request.
- Symlinks are followed, like Express, so a symlink inside `root` can serve
  files from outside it. If users can create files under `root` (an uploads
  folder, for example), set `followSymlinks: false`: the real path, with
  symlinks resolved, must then stay inside the real `root`, otherwise 403.
  The file is opened first and then checked: the opened file must be the
  one found at the real path inside `root`, so swapping the path for a
  symlink while the request runs gets a 403, never the other file. Hard
  links aren't detected, since they have no target to check.
- Sets `Content-Type` from the extension, `Content-Length`, `Last-Modified`,
  a weak `ETag`, `Cache-Control` and `Accept-Ranges`.
- Answers 304 for fresh conditional requests, 412 when `If-Match` or
  `If-Unmodified-Since` fails, and 206 for a single byte range (416 with
  `Content-Range: bytes */<size>` when the range can't be satisfied).
  Requests for several ranges, or with an `If-Range` that no longer matches,
  get the whole file.
- Without a callback, errors go to `next(err)` like in Express, so your error
  middleware sees them: an error with `status` (404 for missing files, 403,
  416, ...) and the file system `code`, such as `"ENOENT"`. Its message is the
  standard status text, never a file path. A directory calls `next()`, so
  later routes can answer.
- With a callback, it receives the error, or nothing on success, and you must
  then respond yourself if the error happened before anything was sent.
- The file is closed if the client disconnects. That is not treated as an
  error without a callback; a callback receives the error.

| Option         | Default    | Description |
| -------------- | ---------- | ----------- |
| `root`         |            | Directory relative paths are resolved against. |
| `maxAge`       | `0`        | `Cache-Control` max-age, in milliseconds. |
| `immutable`    | `false`    | Adds `immutable` to `Cache-Control`. |
| `cacheControl` | `true`     | Set `Cache-Control`. |
| `lastModified` | `true`     | Set `Last-Modified`. |
| `etag`         | `true`     | Set `ETag`. |
| `acceptRanges` | `true`     | Support `Range` requests. |
| `dotfiles`     | `"ignore"` | Files and folders starting with a dot: `"ignore"` (404), `"deny"` (403) or `"allow"`. |
| `index`        | `"index.html"` | Files tried, in order, for a path ending in `/`; `false` turns it off. A path ending in `/` never matches a plain file. |
| `followSymlinks` | `true`   | With `root`: `false` rejects (403) symlinks whose target is outside `root`. |
| `headers`      |            | Extra response headers. |

#### `res.download(path, [filename], [options], [callback])`

Sends a file as an attachment. `filename` is the name shown to the user and
defaults to the file's name. A relative `path` is resolved against the
current working directory unless `options.root` is set. Takes the same
options as `sendFile`.

```ts
res.download("/srv/exports/data.csv", "export.csv");
res.download("q3.pdf", { root: "/srv/reports" }, (err) => { /* ... */ });
```

### Body parsers

Pype includes four body parsers, equivalent to `express.json()`,
`express.urlencoded()`, `express.text()` and `express.raw()`:

```ts
import { json, raw, text, urlencoded } from "pyper-web";

app.use(json());
app.use(urlencoded());
app.post("/webhook", raw({ type: "application/json" }), handleWebhook);
app.post("/notes", text({ limit: "10kb" }), saveNote);
```

| Parser         | Parses by default                     | `req.body` becomes |
| -------------- | ------------------------------------- | ------------------ |
| `json()`       | `application/json`                    | The parsed JSON value |
| `urlencoded()` | `application/x-www-form-urlencoded`   | An object without a prototype; repeated keys become arrays |
| `text()`       | `text/plain`                          | A string |
| `raw()`        | `application/octet-stream`            | A `Buffer` |

Options:

| Option   | Default   | Description |
| -------- | --------- | ----------- |
| `limit`  | `"100kb"` | Maximum body size after decompression, as bytes or a string with `b`, `kb`, `mb` or `gb`. An invalid string or `NaN` throws a `TypeError` when the parser is created. |
| `type`   | see above | Content types to parse: a type, a list of types (same patterns as `req.is()`), or a function `(req) => boolean`. |
| `inflate` | `true`   | Decompress `gzip`, `deflate` and `br` bodies. With `false` they are a 415. |
| `defaultCharset` | `"utf-8"` | Charset when `Content-Type` has none. `urlencoded()`: `"utf-8"` or `"iso-8859-1"`. |
| `verify` |           | `verify(req, res, body, charset)` gets the raw body before parsing; throw to reject with a 403 (`type` defaults to `entity.verify.failed`). |
| `strict` | `true`    | `json()` only: accept only objects and arrays. |
| `reviver` |          | `json()` only: passed to `JSON.parse`. |
| `extended` | `false` | `urlencoded()` only: parse nested keys (`a[b]=c`) and arrays (`a[]=1`) with the rules of `qs`, like `body-parser`. |
| `parameterLimit` | `1000` | `urlencoded()` only: more parameters is a 413. |
| `depth`  | `32`      | `urlencoded()` with `extended` only: deeper keys are a 400. |
| `charsetSentinel`, `interpretNumericEntities` | `false` | `urlencoded()` only, as in `body-parser`: take the charset from a `utf8=` parameter, decode `&#nnn;` in ISO-8859-1 bodies. |

Behaviour:

- Requests without a body, with a different content type, or whose body was
  already parsed by another parser (including the `body-parser` package) are
  passed on unchanged.
- An empty JSON body becomes `{}`. A whitespace-only body is a 400
  `entity.parse.failed`, like `body-parser`, and error messages use its
  wording.
- Charsets, from the `Content-Type` `charset` parameter (UTF-8 by default):
  `json()` accepts UTF-8, UTF-16 and UTF-32; `urlencoded()` accepts UTF-8 and
  ISO-8859-1; `text()` accepts any charset Node can decode. Others are a 415.
  A byte order mark is dropped.
- Compressed bodies (`gzip`, `deflate`, `br`) are decompressed, and `limit`
  counts the decompressed bytes, so a small compressed body can't expand past
  it. Other encodings are a 415.
- `urlencoded()` follows `body-parser` and parses with a port of `qs`, so
  results are the same as in Express. Without `extended`, keys are flat: `+`
  is a space, repeated keys become arrays, a key wrapped in brackets loses
  them (`[a]` is `a`) and `[]` keys become `0`, `1`, .... With `extended`,
  `a[b][c]=1` and `a[]=1` build nested objects and arrays. Empty and
  `__proto__` keys are dropped and objects have no prototype.
- Errors are passed to `next(err)` with `status`, `statusCode`, `expose: true`
  and `type`, like the `body-parser` package:

| Status | `type`                 | When |
| ------ | ---------------------- | ---- |
| 400    | `entity.parse.failed`  | Invalid JSON (including a whitespace-only body), or a primitive in strict mode |
| 400    | `request.aborted`      | The client disconnected before sending the whole body |
| 400    | `querystring.parse.rangeError` | An `extended` form key is deeper than `depth` |
| 400    | (none)                 | The compressed data is invalid |
| 403    | `entity.verify.failed` | `verify` threw (or the `type` of its error) |
| 413    | `entity.too.large`     | The body, decompressed, is larger than `limit` |
| 413    | `parameters.too.many`  | A form has more than `parameterLimit` parameters |
| 415    | `charset.unsupported`  | The charset isn't accepted by the parser (see above) |
| 415    | `encoding.unsupported` | An unknown `Content-Encoding`, or any with `inflate: false` |

### Settings

Set with `app.set(name, value)`, `new Pype({ name: value })`, `app.enable` or
`app.disable`.

| Setting              | Default                                  | Description |
| -------------------- | ---------------------------------------- | ----------- |
| `"env"`              | `process.env.NODE_ENV` or `"development"` | Errors aren't logged by the final handler when this is `"test"`. |
| `"trust proxy"`      | `false`                                  | Which proxies' `X-Forwarded-*` headers to trust; see below. |
| `"etag"`             | `true`                                   | Generate `ETag` headers in `res.send()`. |
| `"json spaces"`      | `undefined`                              | Indentation for `res.json()`. |
| `"json replacer"`    | `undefined`                              | `JSON.stringify` replacer for `res.json()`. |
| `"subdomain offset"` | `2`                                      | Number of dot-separated parts removed from the end of the host name for `req.subdomains`. |
| `"case sensitive routing"` | `true`                             | `false` matches route and mount paths ignoring ASCII case, like Express's default. Applies to every router in the app. |
| `"query parser"`     | `"simple"`                               | How `req.query` is parsed: `"simple"` (Node's `querystring`), `"extended"` (`qs` rules: nested objects and arrays), `false` (no parsing) or a function `(query) => object`, which gets `null` without a `?`. |
| `"views"`            | `"<cwd>/views"`                          | Directory, or list of directories, with the views. |
| `"view engine"`      | `undefined`                              | Extension for view names without one. |
| `"view cache"`       | `true` when `env` is `"production"`      | Remember found views. |
| `"view"`             | Pype's `View`                            | Class that finds and renders views. |

`"trust proxy"` takes the same values as in Express:

| Value                                  | Trusted |
| -------------------------------------- | ------- |
| `false`                                | Nothing; `X-Forwarded-*` headers are ignored |
| `true`                                 | Every proxy (only safe when the app is unreachable except through your proxy) |
| a number `n`                           | The first `n` hops in front of the server |
| `"loopback"`, `"linklocal"`, `"uniquelocal"` | Those address ranges (`127.0.0.1/8` and `::1`; `169.254.0.0/16` and `fe80::/10`; private ranges) |
| an IP or CIDR, e.g. `"10.0.0.0/8"`     | Those addresses |
| a comma-separated string or an array   | Any of the above |
| a function `(address, hop) => boolean` | Whatever it returns `true` for |

```ts
app.set("trust proxy", "loopback");          // nginx on the same machine
app.set("trust proxy", ["loopback", "10.0.0.0/8"]);
```

### TypeScript types

Exported from `pyper-web`:

| Export                | Description |
| --------------------- | ----------- |
| `Pype`, `PypeRouter`, `RouteBuilder` | The application, routers and the builder returned by `route()`. |
| `Request`, `Response` | The request and response classes, usable as types. |
| `Middleware`          | `(req, res, next) => unknown` |
| `ErrorMiddleware`     | `(err, req, res, next) => unknown` |
| `RouteHandler`        | Same as `Middleware`. |
| `AnyHandler`          | Any function; accepts handlers typed for Express. |
| `NextFunction`        | `(err?: any) => void` |
| `RouteInfo`           | The type of `req.route`. |
| `CookieOptions`       | Options of `res.cookie()`. |
| `SendFileOptions`     | Options of `res.sendFile()` and `res.download()`. |
| `BodyParserOptions`, `JsonOptions`, `UrlencodedOptions` | Options of the body parsers. |
| `UseHandler`, `HandlerParam`, `PathParam` | What `use()` and route methods accept; `PathParam` is a string, RegExp or array. |
| `ParamHandler`        | A `param()` callback. |
| `View`, `Engine`, `ViewOptions` | The view class (to extend for `app.set("view", ...)`), and the template engine signature. |

Handlers passed inline get their parameter types inferred:

```ts
app.get("/users/:id", (req, res) => {
  req.params.id;   // string
  res.json({});    // Response
});
```

Type augmentations written for Express also apply to Pype, so packages such
as `@types/passport` or `@types/multer` add `req.user` or `req.file` to Pype's
`Request` as well. To add your own:

```ts
declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
    }
  }
}
```

## Using Express middleware

Anything written for Express 5 can be passed to `app.use()` or to a route:

```ts
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import session from "express-session";
import { rateLimit } from "express-rate-limit";
import serveStatic from "serve-static";
import multer from "multer";

app.use(helmet(), cors({ origin: "https://example.com" }), morgan("combined"));
app.use(compression());
app.use(cookieParser("cookie-secret"));
app.use(session({ secret: "session-secret", resave: false, saveUninitialized: false }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 100 }));
app.use("/static", serveStatic("public"));

app.post("/upload", multer().single("file"), (req, res) => {
  res.json({ size: (req as any).file.size });
});
```

The test suite runs against the packages above and `body-parser`. Middleware
typed for Express (with `@types/express`) is accepted by the TypeScript
types.

## Recipes

### A JSON API with validation and errors

```ts
import { ErrorMiddleware, Pype, PypeRouter, Request, Response, json } from "pyper-web";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const app = new Pype();
const todos = new PypeRouter();

app.use(json({ limit: "10kb" }));

todos.get("/:id", async (req, res) => {
  const todo = await db.todos.find(req.params.id);
  if (!todo) throw new HttpError(404, "Todo not found");
  res.json(todo);
});

todos.post("/", (req, res) => {
  if (typeof req.body?.title !== "string") throw new HttpError(400, "title is required");
  res.status(201).json(db.todos.create(req.body.title));
});

app.use("/todos", todos);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

const onError: ErrorMiddleware = (err, req, res, next) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: status < 500 ? err.message : "Internal Server Error" });
};
app.use(onError);

app.listen(3000);
```

### Authentication on part of the app

```ts
import { NextFunction, Request, Response } from "pyper-web";

const requireUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.get("Authorization")) return res.sendStatus(401);
  next();
};

app.use("/admin", requireUser);   // also covers /admin/... and //admin/...
app.use("/admin", adminRouter);
```

### Behind a reverse proxy

```ts
const app = new Pype();
app.set("trust proxy", "loopback");

const server = app.listen(3000, "127.0.0.1");
```

### Graceful shutdown

```ts
const server = app.listen(3000);

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));   // finish in-flight requests
  server.closeIdleConnections();
});
```

### Testing with supertest

```ts
import request from "supertest";

const response = await request(app.handler).get("/users/1");
expect(response.status).toBe(200);
```

## Migrating from Express

Most Express 5 apps only need the import changed:

```ts
// before
import express from "express";
const app = express();
const router = express.Router();
app.use(express.json());

// after
import { Pype, PypeRouter, json } from "pyper-web";
const app = new Pype();
const router = new PypeRouter();
app.use(json());
```

| Express                                | Pype |
| -------------------------------------- | ---- |
| `express()`                            | `new Pype()` |
| `express.Router()`, `express.Router({ mergeParams: true })` | `new PypeRouter()`, `new PypeRouter({ mergeParams: true })` |
| `express.json()`, `urlencoded()`, `text()`, `raw()` | `json()`, `urlencoded()`, `text()`, `raw()` |
| `express.static(dir)`                  | `serveStatic(dir)` from the `serve-static` package |
| `http.createServer(app)`               | `http.createServer(app.handler)` |
| `request(app)` in supertest            | `request(app.handler)` |

Compatibility at a glance:

| Express feature | Pype |
| --- | --- |
| Middleware, error middleware, async errors | Same |
| `next()`, `next(err)`, `next("route")`, `next("router")` | Same; a second `next()` call is ignored |
| Routers, mount paths, `req.baseUrl` / `path` / `originalUrl` | Same |
| Request API (`accepts*`, `is`, `range`, `fresh`, `ip`, `ips`, `protocol`, `hostname`, `subdomains`, ...) | Same, checked by the differential tests |
| Response API (`send`, `json`, `status`, `set`, `type`, `vary`, `format`, `redirect`, `cookie`, `attachment`, `sendFile`, `download`, ...) | Same, checked by the differential tests |
| Automatic `OPTIONS` and `HEAD` | Same, also from mounted routers |
| `app.param()`, `router.param()` | Same |
| RegExp and array paths | Same, except mounting a router on a RegExp |
| `app.engine()`, `app.render()`, `res.render()`, view settings | Same, Express engines work |
| `"trust proxy"`, `"query parser"` | Same values and results |
| Body parsers, including compressed bodies and `extended: true` | Same results and errors |
| Route matching | Most specific route wins, not the first registered |
| Route syntax | Express 4 style `:id?` and `*`, not Express 5's `{/:id}` and `*name` |
| Case sensitivity | Case-sensitive by default; `"case sensitive routing": false` for Express's default |
| Duplicate and trailing slashes | Always ignored |
| Default 404 and error responses | JSON instead of HTML |
| `res.jsonp()`, `req.param()`, `app.use(otherApp)` | Not implemented |

Differences:

- When several patterns match a URL, the most specific wins (static, then
  `:param`, then `*`) instead of the first registered. Routes with the same
  method and path still run in registration order.
- Duplicate and trailing slashes are always ignored.
- Routing is case-sensitive unless `"case sensitive routing"` is `false`;
  Express ignores case by default. The setting covers every router in the
  app, there is no per-router `caseSensitive` option.
- The default 404 and error responses are JSON.
- A second `next()` call from the same handler is ignored with a warning;
  Express continues with the following layer.
- `res.sendFile()` errors have the standard status text as message; Express
  passes the file system error, whose message includes the file path.
- A router can't be mounted on a regular expression (it throws); RegExp
  routes and middleware work.
- Optional parameters and wildcards use the Express 4 syntax: `/:id?` and
  `/files/*` (`req.params["*"]`), where Express 5 uses `{/:id}` and
  `/*name`.
- Not implemented: several parameters in one segment (`/:from-:to`, which
  throws), mounting another app with `app.use(otherApp)`, `res.jsonp()`,
  `req.param()`, and the `"strict routing"` and `"x-powered-by"` settings.

## Production notes

- **Proxies**: leave `"trust proxy"` off unless the app is behind a proxy you
  control, and then trust only that proxy. It decides `req.ip`, `req.protocol`
  and `req.hostname`.
- **Body size**: the body parsers reject bodies over `limit` with 413. Keep
  the default 100kb unless you need more.
- **Files**: use `res.sendFile(path, { root })` for paths from the request.
  Traversal outside the root is rejected, dotfiles are hidden by default, and
  the file is closed when the client disconnects. Symlinks are followed by
  default; add `followSymlinks: false` if users can create files under the
  root.
- **Errors**: the final handler only exposes the messages of 4xx errors to
  clients and logs every error with `console.error` unless `env` is `"test"`.
  Register your own error middleware to log elsewhere.
- **Security headers**: use `helmet`. Pype doesn't add an `X-Powered-By`
  header.
- **Views**: `"view cache"` is on when `env` is `"production"`; set
  `NODE_ENV=production` so templates aren't looked up on every request.
- **Shutdown**: `listen()` returns the `http.Server`, so you can stop it
  cleanly on `SIGTERM`.

To report a vulnerability, see [SECURITY.md](https://github.com/HlufD/pipe-router/blob/main/docs/SECURITY.md).

## Performance

`npm run bench` load-tests a bare Node.js server, Pype and Express 5 with the
same 60 routes. On a 14-core Linux machine with Node 24:

| Route              | Pype req/s | Express req/s | Speedup |
| ------------------ | ---------- | ------------- | ------- |
| static             | 28,690     | 19,708        | 1.46×   |
| static, last of 60 | 26,757     | 18,699        | 1.43×   |
| 1 param            | 26,770     | 19,400        | 1.38×   |
| 3 params           | 26,629     | 18,165        | 1.47×   |
| wildcard           | 26,789     | 15,739        | 1.70×   |
| not found          | 25,925     | 20,152        | 1.29×   |

A bare Node.js server reached 34,437 req/s on the same machine. Results vary
by about ±10% between runs; measure on your own hardware before relying on
them. `npm run bench:router` measures route lookups alone.

## Development

```sh
npm test               # all tests
npm run test:coverage  # tests with coverage thresholds
npm run test:fuzz      # property-based and differential fuzzing, 20,000 runs per property
npm run typecheck
npm run build          # dist/ with type declarations
npm run bench          # HTTP benchmark against Express, with memory and GC figures
npm run bench:etag     # cost of ETag hashing by body size
```

The differential tests (`tests/differential.test.ts`) run every request
against Express 5 and Pype and compare the responses, and the raw socket tests
(`tests/http-edge.test.ts`) check HEAD, 204, 304, keep-alive, pipelining,
aborted bodies, `100-continue` and malformed requests against Express too.
CI runs everything on Linux and macOS with Node 22, 24 and 26, and a nightly
job runs the fuzzers at 20,000 runs per property.

See [the architecture guide](https://github.com/HlufD/pipe-router/blob/main/docs/ARCHITECTURE.md) for how the framework is built.

## License

[ISC](LICENSE)
