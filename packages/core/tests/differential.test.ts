import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { Pype } from "../src/core/server";
import { PypeRouter } from "../src/core/router";
import { json, raw, text, urlencoded } from "../src/middlewares/body-parser";
import { View } from "../src/core/view";
import fc from "fast-check";
import { Reply, SendOptions, start, TestServer } from "./support/http";

/**
 * Differential tests: the same routes are mounted on Express 5 and on Pype,
 * every request is sent to both, and status, body and the headers below must
 * be identical. Each `it` names the request, so a failure shows what differs.
 */

/** Headers whose values must match. Date, Connection, Keep-Alive and X-Powered-By may differ. */
const HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "vary",
  "link",
  "set-cookie",
  "allow",
  "x-test",
];

type Kind = "express" | "pype";

/** An Express app and a Pype app built from the same definition. */
type Pair = Record<Kind, TestServer>;

/** Runs of the fuzz properties, raise with FUZZ_RUNS for deeper runs. */
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);

/** Starts an Express and a Pype app, both set up by `setup`. */
async function startPair(setup: (app: any, kind: Kind) => void, settings: Record<string, unknown> = {}): Promise<Pair> {
  const e = express();
  const p = new Pype({ env: "test" });
  for (const [name, value] of Object.entries(settings)) {
    e.set(name, value);
    p.set(name, value);
  }
  setup(e, "express");
  setup(p, "pype");
  return { express: await start(e as any), pype: await start(p) };
}

const root = mkdtempSync(join(tmpdir(), "pype-diff-"));

/** Body parsers and routers of each framework, with the same options. */
function kit(kind: Kind): Record<string, any> {
  return kind === "express"
    ? { json: express.json, urlencoded: express.urlencoded, text: express.text, raw: express.raw, Router: (options?: object) => express.Router(options) }
    : { json, urlencoded, text, raw, Router: (options?: object) => new PypeRouter(options) };
}

/** Registers the shared routes. Handlers only use the API both frameworks have. */
function define(app: any, kind: Kind) {
  const k = kit(kind);
  // Express 5 names wildcards, Pype uses a bare `*`.
  const wild = kind === "express" ? "*rest" : "*";
  app.set("etag", true);
  app.use(cookieParser("secret"));

  // Content negotiation
  app.get("/accepts", (req: any, res: any) =>
    res.json({
      all: req.accepts(),
      json: req.accepts("json"),
      html: req.accepts("html"),
      list: req.accepts(["json", "html", "text"]),
      mime: req.accepts("application/json", "text/html"),
      png: req.accepts("image/png"),
    }),
  );
  app.get("/charsets", (req: any, res: any) =>
    res.json({ all: req.acceptsCharsets(), utf8: req.acceptsCharsets("utf-8"), pick: req.acceptsCharsets("utf-8", "iso-8859-1") }),
  );
  app.get("/encodings", (req: any, res: any) =>
    res.json({
      all: req.acceptsEncodings(),
      gzip: req.acceptsEncodings("gzip"),
      pick: req.acceptsEncodings("gzip", "br"),
      identity: req.acceptsEncodings("identity"),
    }),
  );
  app.get("/languages", (req: any, res: any) =>
    res.json({ all: req.acceptsLanguages(), en: req.acceptsLanguages("en"), pick: req.acceptsLanguages("en-US", "fr"), de: req.acceptsLanguages("de") }),
  );
  app.get("/format", (_req: any, res: any) =>
    res.format({
      "text/plain": () => res.send("text"),
      "text/html": () => res.send("<p>html</p>"),
      "application/json": () => res.json({ json: true }),
    }),
  );
  app.get("/format-default", (_req: any, res: any) =>
    res.format({ json: () => res.json({ json: true }), default: () => res.status(406).send("none") }),
  );
  app.post("/is", (req: any, res: any) =>
    res.json({ json: req.is("json"), html: req.is("html"), any: req.is(), multi: req.is("text/*", "json"), plus: req.is("+json") }),
  );
  app.get("/range", (req: any, res: any) =>
    res.json({ plain: req.range(1000), combined: req.range(1000, { combine: true }), type: (req.range(1000) || {}).type }),
  );

  // Request properties
  app.get("/props", (req: any, res: any) =>
    res.json({
      path: req.path,
      baseUrl: req.baseUrl,
      originalUrl: req.originalUrl,
      url: req.url,
      query: req.query,
      xhr: req.xhr,
      fresh: req.fresh,
      stale: req.stale,
      referer: req.get("referrer") ?? null,
    }),
  );
  app.get("/params/:id", (req: any, res: any) => res.json(req.params));
  app.get("/café", (_req: any, res: any) => res.send("unicode route"));
  app.get(`/wild/${wild}`, (req: any, res: any) => res.json({ path: req.path }));

  // Responses
  app.get("/send/string", (_req: any, res: any) => res.send("hello"));
  app.get("/send/empty-string", (_req: any, res: any) => res.send(""));
  app.get("/send/buffer", (_req: any, res: any) => res.send(Buffer.from("bytes")));
  app.get("/send/object", (_req: any, res: any) => res.send({ a: 1, b: [true, null] }));
  app.get("/send/array", (_req: any, res: any) => res.send([1, "two"]));
  app.get("/send/null", (_req: any, res: any) => res.send(null));
  app.get("/send/undefined", (_req: any, res: any) => res.send(undefined));
  app.get("/send/typed", (_req: any, res: any) => res.type("text").send("typed"));
  app.get("/send/html-type", (_req: any, res: any) => res.set("Content-Type", "text/html").send(Buffer.from("<b>")));
  app.get("/send/204", (_req: any, res: any) => res.status(204).send("dropped"));
  app.get("/send/304", (_req: any, res: any) => res.status(304).send("dropped"));
  app.get("/send/205", (_req: any, res: any) => res.status(205).send("dropped"));
  app.get("/json/null", (_req: any, res: any) => res.json(null));
  app.get("/json/string", (_req: any, res: any) => res.json("str"));
  app.get("/json/number", (_req: any, res: any) => res.json(42));
  app.get("/json/escape", (_req: any, res: any) => res.json({ html: "<script>&</script>" }));
  app.get("/status/201", (_req: any, res: any) => res.status(201).json({ created: true }));
  app.get("/send-status/:code", (req: any, res: any) => res.sendStatus(Number(req.params.code)));
  app.get("/fresh", (_req: any, res: any) => {
    res.set("ETag", '"v1"');
    res.set("Last-Modified", new Date(Date.UTC(2026, 0, 1)).toUTCString());
    res.send("cached");
  });
  app.get("/etag", (_req: any, res: any) => res.send("etag body"));

  // Headers
  app.get("/vary", (_req: any, res: any) => res.vary("Accept").vary("Origin, accept").vary("User-Agent").send("ok"));
  app.get("/vary-star", (_req: any, res: any) => res.vary("*").vary("Accept").send("ok"));
  app.get("/vary-array", (_req: any, res: any) => res.vary(["Accept", "Origin"]).vary(["origin", "X-Custom"]).send("ok"));
  app.get("/vary-invalid", (_req: any, res: any) => res.vary("bad header").send("ok"));
  app.get("/type/:t", (req: any, res: any) => res.type(req.params.t).send("ok"));
  app.get("/set-charset", (_req: any, res: any) => res.set("Content-Type", "text/plain").send("ok"));
  app.get("/append", (_req: any, res: any) => res.append("X-Test", "a").append("X-Test", ["b", "c"]).send("ok"));
  app.get("/links", (_req: any, res: any) => res.links({ next: "/p/2", last: "/p/9" }).links({ prev: "/p/0" }).send("ok"));
  app.get("/attachment", (_req: any, res: any) => res.attachment("reports/2026 résumé.pdf").send("pdf"));
  app.get("/attachment-quote", (_req: any, res: any) => res.attachment('a"b\\c.txt').send("txt"));
  app.get("/attachment-cjk", (_req: any, res: any) => res.attachment("测试.pdf").send("pdf"));
  app.get("/location", (req: any, res: any) => res.location(String(req.query.to)).end());

  // Cookies
  app.get("/cookie/basic", (_req: any, res: any) => res.cookie("a", "b").send("ok"));
  app.get("/cookie/object", (_req: any, res: any) => res.cookie("cart", { items: [1, 2] }).send("ok"));
  app.get("/cookie/attributes", (_req: any, res: any) =>
    res
      .cookie("full", "v a;l", {
        domain: "example.com",
        path: "/admin",
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        priority: "high",
        partitioned: true,
        expires: new Date(Date.UTC(2030, 0, 1)),
      })
      .send("ok"),
  );
  app.get("/cookie/samesite-true", (_req: any, res: any) => res.cookie("s", "1", { sameSite: true }).send("ok"));
  app.get("/cookie/signed", (_req: any, res: any) => res.cookie("sig", "value", { signed: true }).send("ok"));
  app.get("/cookie/clear", (_req: any, res: any) => res.clearCookie("a", { path: "/x" }).send("ok"));
  app.get("/cookie/read", (req: any, res: any) => res.json({ cookies: req.cookies, signed: req.signedCookies }));
  app.get("/cookie/invalid", (_req: any, res: any) => res.cookie("p", "1", { priority: "Bogus" }).send("ok"));
  app.get("/cookie/injection", (_req: any, res: any) => res.cookie("p", "1", { path: "/; HttpOnly" }).send("ok"));

  // Redirects
  app.get("/redirect", (req: any, res: any) => res.redirect(String(req.query.to)));
  app.get("/redirect-301", (_req: any, res: any) => res.redirect(301, "/moved"));

  // Header injection: Node rejects the value, the error reaches error middleware
  app.get("/crlf/set", (_req: any, res: any) => res.set("X-Test", "a\r\nSet-Cookie: x=1").send("ok"));
  app.get("/crlf/location", (_req: any, res: any) => res.location("/a\r\nSet-Cookie: x=1").end());

  // Pipeline semantics
  app.get("/route", (_req: any, _res: any, next: any) => next("route"), (_req: any, res: any) => res.send("skipped"));
  app.get("/route", (_req: any, res: any) => res.send("second route"));
  app.get("/throw", () => {
    throw Object.assign(new Error("sync boom"), { status: 418 });
  });
  app.get("/reject", async () => {
    throw Object.assign(new Error("async boom"), { status: 409 });
  });
  app.get("/next-error", (_req: any, _res: any, next: any) => next(Object.assign(new Error("next boom"), { status: 422 })));
  app.get(
    "/error-chain",
    (_req: any, _res: any, next: any) => next(new Error("first")),
    (_err: any, _req: any, _res: any, next: any) => next(),
    (_req: any, res: any) => res.send("recovered"),
  );
  app.get("/after-response", (_req: any, res: any, next: any) => {
    res.send("sent");
    next();
  });
  app.get("/double-next", (_req: any, _res: any, next: any) => {
    next();
    next();
  });
  app.get("/double-next", (_req: any, res: any) => res.send("once"));

  // Nested routers with next("router") at each level and async middleware
  const api = k.Router();
  const admin = k.Router();
  api.use(async (req: any, res: any, next: any) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.append("X-Test", `api:${req.baseUrl}|${req.path}`);
    if (req.query.leave === "api") return next("router");
    next();
  });
  admin.use((req: any, res: any, next: any) => {
    res.append("X-Test", `admin:${req.baseUrl}|${req.path}`);
    if (req.query.leave === "admin") return next("router");
    next();
  });
  admin.get("/users/:id", (req: any, res: any) =>
    res.json({ id: req.params.id, baseUrl: req.baseUrl, path: req.path, url: req.url, originalUrl: req.originalUrl }),
  );
  api.use("/admin", admin);
  api.get("/admin/users/:id", (req: any, res: any) => res.json({ fallback: "api", baseUrl: req.baseUrl, path: req.path }));
  app.use("/api", api);
  app.get("/api/admin/users/:id", (req: any, res: any) => res.json({ fallback: "app", baseUrl: req.baseUrl, path: req.path }));

  // Body parsers
  app.post("/body/json", k.json({ limit: "1kb" }), (req: any, res: any) => res.json({ body: req.body ?? "missing" }));
  app.post("/body/json-loose", k.json({ strict: false }), (req: any, res: any) => res.json({ body: req.body ?? "missing" }));
  app.post("/body/json-no-inflate", k.json({ inflate: false }), (req: any, res: any) => res.json({ body: req.body ?? "missing" }));
  app.post("/body/form", k.urlencoded({ extended: false } as any), (req: any, res: any) => res.json({ body: { ...req.body } }));
  app.post("/body/text", k.text(), (req: any, res: any) => res.json({ body: req.body ?? "missing" }));
  app.post("/body/raw", k.raw(), (req: any, res: any) => res.json({ length: req.body?.length ?? "missing" }));

  // Files
  app.get(`/file/${wild}`, (req: any, res: any) => res.sendFile(req.path.slice("/file/".length), { root: decodeURIComponent(root) }));
  app.get("/download", (_req: any, res: any) => res.download(join(root, "hello.txt"), "greeting.txt"));
  app.get(`/file-no-index/${wild}`, (req: any, res: any) =>
    res.sendFile(req.path.slice("/file-no-index/".length), { root: decodeURIComponent(root), index: false }),
  );
  app.get(`/file-custom-index/${wild}`, (req: any, res: any) =>
    res.sendFile(req.path.slice("/file-custom-index/".length), { root: decodeURIComponent(root), index: ["default.htm", "index.html"] }),
  );

  app.use((req: any, res: any) => res.status(404).json({ notFound: `${req.method} ${req.path}` }));
  // Error messages are implementation details (Node's JSON.parse wording,
  // file paths), so only the status and `type` are compared.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.status ?? err.statusCode ?? null, type: err.type ?? null });
  });
}

/** Sends `options` to both servers. */
async function both(path: string, options: SendOptions = {}, pair: Pair = servers): Promise<[Reply, Reply]> {
  // A request that fails outright says which server, port and path, so a
  // rare failure can be diagnosed from the CI log alone.
  const send = (kind: Kind) =>
    pair[kind].send(path, options).catch((error: NodeJS.ErrnoException) => {
      throw Object.assign(
        new Error(`${kind} on port ${pair[kind].port}: ${options.method ?? "GET"} ${path} failed with ${error.code ?? error.message}`),
        { cause: error },
      );
    });
  return Promise.all([send("express"), send("pype")]);
}

/** The part of a reply that must match. */
function observable(reply: Reply) {
  const headers: Record<string, unknown> = {};
  for (const name of HEADERS) if (reply.headers[name] !== undefined) headers[name] = reply.headers[name];
  return { status: reply.status, headers, body: reply.text };
}

/** Asserts that both frameworks answer `path` the same way. */
async function same(path: string, options: SendOptions = {}, pair: Pair = servers) {
  const [fromExpress, fromPype] = await both(path, options, pair);
  expect(observable(fromPype)).toEqual(observable(fromExpress));
}

let servers: Pair;

beforeAll(async () => {
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "hello.txt"), "hello world");
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "docs", "readme.md"), "# readme");
  writeFileSync(join(root, ".secret"), "hidden");
  mkdirSync(join(root, "site"));
  writeFileSync(join(root, "site", "index.html"), "<p>site index</p>");
  mkdirSync(join(root, "alt"));
  writeFileSync(join(root, "alt", "default.htm"), "<p>alt default</p>");
  mkdirSync(join(root, "site", "index.html.d"));

  servers = await startPair(define);
});

afterAll(async () => {
  await Promise.all([servers.express.close(), servers.pype.close()]);
  rmSync(root, { recursive: true, force: true });
});

const ACCEPT = [
  undefined,
  "*/*",
  "application/json",
  "text/html",
  "text/html;q=0.5, application/json",
  "application/json;q=0.9, text/html;q=1",
  "application/*;q=0.5",
  "application/json;q=0",
  "text/*, application/json;q=0.8",
  "image/*",
  "text/plain;format=flowed",
  "TEXT/HTML",
  "application/json;q=abc",
  "application/json;q=2",
  ",,,",
];

describe("content negotiation matches Express", () => {
  it.each(ACCEPT)("req.accepts() with Accept: %s", (accept) =>
    same("/accepts", { headers: accept === undefined ? {} : { Accept: accept } }),
  );

  it.each(ACCEPT)("res.format() with Accept: %s", (accept) =>
    same("/format", { headers: accept === undefined ? {} : { Accept: accept } }),
  );

  it.each(["image/png", "text/html"])("res.format() default with Accept: %s", (accept) =>
    same("/format-default", { headers: { Accept: accept } }),
  );

  it.each([undefined, "utf-8", "iso-8859-1, utf-8;q=0.5", "*", "utf-8;q=0", "UTF-8"])(
    "req.acceptsCharsets() with Accept-Charset: %s",
    (value) => same("/charsets", { headers: value === undefined ? {} : { "Accept-Charset": value } }),
  );

  it.each([undefined, "", "gzip", "gzip, br", "br;q=0.5, gzip", "*", "identity;q=0", "gzip, identity;q=0", "*;q=0", "GZIP", "gzip;q=0"])(
    "req.acceptsEncodings() with Accept-Encoding: %s",
    (value) => same("/encodings", { headers: value === undefined ? {} : { "Accept-Encoding": value } }),
  );

  it.each([undefined, "en", "en-US", "en-US, fr;q=0.5", "fr, en;q=0.1", "*", "de;q=0", "EN-us", "en-GB"])(
    "req.acceptsLanguages() with Accept-Language: %s",
    (value) => same("/languages", { headers: value === undefined ? {} : { "Accept-Language": value } }),
  );

  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "text/html",
    "text/plain",
    "application/vnd.api+json",
    "multipart/form-data; boundary=x",
    "invalid",
  ])("req.is() with Content-Type: %s", (type) =>
    same("/is", { method: "POST", headers: { "Content-Type": type }, body: "x" }),
  );

  it("req.is() without a body", () => same("/is", { method: "POST" }));

  it.each([
    "bytes=0-99",
    "bytes=0-99, 200-",
    "bytes=-100",
    "bytes=900-",
    "bytes=0-1, 1-5, 10-20",
    "bytes=2000-3000",
    "bytes=10-5",
    "bytes=0-1,garbage",
    "bytes=garbage",
    "bytes",
    "items=0-5",
    "bytes=0-5abc",
    "bytes= 0 - 5 ",
    "bytes=-5,5-99",
    "bytes=500-600, 0-10, 550-700, 5-20",
  ])("req.range() with Range: %s", (range) => same("/range", { headers: { Range: range } }));
});

describe("responses match Express", () => {
  it.each([
    "/send/string",
    "/send/empty-string",
    "/send/buffer",
    "/send/object",
    "/send/array",
    "/send/null",
    "/send/undefined",
    "/send/typed",
    "/send/html-type",
    "/send/204",
    "/send/304",
    "/send/205",
    "/json/null",
    "/json/string",
    "/json/number",
    "/json/escape",
    "/status/201",
    "/send-status/200",
    "/send-status/404",
    "/send-status/418",
    "/send-status/599",
  ])("GET %s", (path) => same(path));

  it.each(["/send/string", "/send/object", "/send/204", "/fresh"])("HEAD %s", (path) => same(path, { method: "HEAD" }));

  it.each([
    {},
    { "If-None-Match": '"v1"' },
    { "If-None-Match": 'W/"v1"' },
    { "If-None-Match": '"other"' },
    { "If-None-Match": '"other", "v1"' },
    { "If-None-Match": "*" },
    { "If-Modified-Since": new Date(Date.UTC(2026, 0, 2)).toUTCString() },
    { "If-Modified-Since": new Date(Date.UTC(2025, 0, 1)).toUTCString() },
    { "If-Modified-Since": "garbage" },
    { "If-None-Match": '"other"', "If-Modified-Since": new Date(Date.UTC(2026, 0, 2)).toUTCString() },
    { "If-None-Match": '"v1"', "If-Modified-Since": new Date(Date.UTC(2025, 0, 1)).toUTCString() },
    { "If-None-Match": '"v1"', "Cache-Control": "no-cache" },
  ])("conditional GET with %o", (headers) => same("/fresh", { headers: headers as Record<string, string> }));

  it("generates the same ETag and answers 304 for it", async () => {
    await same("/etag");
    const etag = (await servers.express.send("/etag")).headers.etag as string;
    await same("/etag", { headers: { "If-None-Match": etag } });
  });

  it.each(["/vary", "/vary-star", "/vary-array", "/vary-invalid", "/set-charset", "/append", "/links", "/attachment", "/attachment-quote", "/attachment-cjk"])(
    "headers of %s",
    (path) => same(path),
  );

  it.each(["json", "html", "text", ".png", "png", "application/x-custom", "text/x-custom", "bin", "unknownext"])(
    "res.type(%s)",
    (type) => same(`/type/${encodeURIComponent(type)}`),
  );

  it.each(["/a b", "/caf%C3%A9", "/café", "https://example.com/?q=a b&x=%20", "/%zz", "/path?x=<script>"])(
    "res.location(%s)",
    (to) => same(`/location?to=${encodeURIComponent(to)}`),
  );
});

describe("redirects match Express", () => {
  const targets = [
    "/login",
    "https://example.com/a b",
    "/caf%C3%A9",
    "/<script>alert(1)</script>",
    "javascript:alert('x')",
    "//evil.example/path",
    "/%0d%0aSet-Cookie:%20x=1",
    "/a?b=\"c\"&d='e'",
  ];
  const accepts = [undefined, "text/html", "text/plain", "application/json", "*/*"];

  for (const to of targets) {
    it.each(accepts)(`res.redirect(${JSON.stringify(to)}) with Accept: %s`, (accept) =>
      same(`/redirect?to=${encodeURIComponent(to)}`, { headers: accept === undefined ? {} : { Accept: accept } }),
    );
  }

  it("res.redirect(301, url) and HEAD", async () => {
    await same("/redirect-301");
    await same("/redirect-301", { method: "HEAD" });
  });
});

describe("cookies match Express", () => {
  it.each([
    "/cookie/basic",
    "/cookie/object",
    "/cookie/attributes",
    "/cookie/samesite-true",
    "/cookie/signed",
    "/cookie/clear",
    "/cookie/invalid",
    "/cookie/injection",
  ])("GET %s", (path) => same(path));

  it("parses plain, JSON and signed cookies", async () => {
    const signed = (await servers.express.send("/cookie/signed")).headers["set-cookie"]![0].split(";")[0];
    await same("/cookie/read", { headers: { Cookie: `a=b; cart=j%3A%7B%22x%22%3A1%7D; ${signed}; bad=s%3Avalue.wrong` } });
  });
});

describe("header injection is rejected like Express", () => {
  it.each(["/crlf/set", "/crlf/location"])("GET %s", async (path) => {
    const [fromExpress, fromPype] = await both(path);
    expect(fromPype.status).toBe(fromExpress.status);
    expect(fromPype.headers["set-cookie"]).toBeUndefined();
    expect(fromExpress.headers["set-cookie"]).toBeUndefined();
  });
});

describe("routing and params match Express", () => {
  it("a router mounted on a path with a param sees the matched base", async () => {
    const pair = await startPair((app, kind) => {
      const router = kit(kind).Router();
      const reply = (req: any, res: any) =>
        res.json({ params: req.params, baseUrl: req.baseUrl, url: req.url, path: req.path, originalUrl: req.originalUrl });
      router.get("/:id", reply);
      router.use(reply);
      app.use("/orgs/:org", router);
    });
    try {
      for (const path of ["/orgs/a/42", "/orgs/acme/42", "/orgs/acmecorp/42?x=1", "/orgs/acme", "/orgs/acme/"]) {
        for (const method of ["GET", "POST"]) await same(path, { method }, pair);
      }
    } finally {
      await Promise.all([pair.express.close(), pair.pype.close()]);
    }
  });

  it.each([
    "/params/42",
    "/params/a%20b",
    "/params/a%2Fb",
    "/params/caf%C3%A9",
    "/params/%E6%97%A5%E6%9C%AC",
    "/params/a+b",
    "/params/%ZZ",
    "/params/%E0%A4%A",
    "/params/%",
    "/params/%00",
    "/params/42?x=1&x=2",
    "/caf%C3%A9",
    "/CAF%C3%A9",
    "/wild/a/b/c",
    "/wild/a%2Fb",
    "/missing",
  ])("GET %s", (path) => same(path));

  it.each([
    "/props",
    "/props?a=1&a=2&b=",
    "/props?a[b]=c&d=%20e",
    "/props?__proto__=x&constructor=y&prototype=z&hasOwnProperty=w",
    "/props?%=bad&a=%zz",
    "/props?empty&=value",
    "/props?a=1&a=2&a=3",
  ])("GET %s", (path) => same(path));

  it("request properties with headers", () =>
    same("/props?x=1", { headers: { "X-Requested-With": "XMLHttpRequest", Referer: "http://a.example/", Host: "app.example:8080" } }),
  );

  it.each(["/route", "/throw", "/reject", "/next-error", "/error-chain", "/after-response"])(
    "pipeline: GET %s",
    (path) => same(path),
  );

  it.each([
    "/api/admin/users/7",
    "/api/admin/users/7?leave=admin",
    "/api/admin/users/7?leave=api",
    "/api/admin/users/a%20b",
  ])("nested routers: GET %s", (path) => same(path));

  describe.each([false, true])("nested routers with mergeParams: %s", (mergeParams) => {
    let pair: Pair;

    beforeAll(async () => {
      pair = await startPair((app, kind) => {
        const k = kit(kind);
        const orgs = k.Router({ mergeParams });
        const teams = k.Router({ mergeParams });
        const reply = (where: string) => (req: any, res: any) =>
          res.json({ where, params: req.params, calls: req.calls ?? [], baseUrl: req.baseUrl });
        const track = (name: string) => (req: any, _res: any, next: any, value: string) => {
          (req.calls ??= []).push(`${name}=${value}`);
          if (value === "renamed") req.params[name] = "changed";
          next(value === "blocked" ? Object.assign(new Error("no"), { status: 403 }) : undefined);
        };
        app.param("org", track("app:org"));
        orgs.param("team", track("orgs:team"));
        orgs.param("org", track("orgs:org"));
        teams.param("id", track("teams:id"));
        teams.param("team", track("teams:team"));

        teams.get("/:id", reply("teams route"));
        teams.get(/^\/re\/(\d+)$/, reply("teams regexp"));
        teams.use("/m/:x", reply("teams middleware"));
        teams.use("/w", (req: any, res: any) => {
          req.params.written = "yes";
          res.json(req.params);
        });
        orgs.use("/teams/:team", teams);
        orgs.get("/same/:org", reply("orgs same name"));
        orgs.get("/", reply("orgs route"));
        app.use("/orgs/:org", orgs);
        app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.status }));
      });
    });

    afterAll(() => Promise.all([pair.express.close(), pair.pype.close()]));

    it.each([
      "/orgs/acme",
      "/orgs/acme/teams/red/7",
      "/orgs/renamed/teams/red/7",
      "/orgs/acme/teams/renamed/7",
      "/orgs/blocked/teams/red/7",
      "/orgs/acme/teams/blocked/7",
      "/orgs/acme/teams/red/re/42",
      "/orgs/acme/teams/red/m/x1/more",
      "/orgs/caf%C3%A9/teams/a%20b/%E2%82%AC",
      "/orgs/acme/same/other",
      "/orgs/%ZZ/teams/red/7",
      "/orgs/acme/teams/red/w",
    ])("GET %s", (path) => same(path, {}, pair));
  });

  describe.each([false, true])("case sensitive routing: %s", (caseSensitive) => {
    let pair: Pair;

    beforeAll(async () => {
      pair = await startPair(
        (app, kind) => {
          const k = kit(kind);
          // Express's routers have their own option, Pype's setting covers every router.
          const router = k.Router({ caseSensitive });
          const reply = (where: string) => (req: any, res: any) =>
            res.json({ where, params: req.params, baseUrl: req.baseUrl, path: req.path, url: req.url });
          app.get("/Users/:Name", reply("user"));
          app.get(kind === "express" ? "/files/*rest" : "/files/*", (req: any, res: any) =>
            res.json({ rest: [req.params.rest ?? req.params["*"]].flat().join("/") }),
          );
          app.get("/caf%C3%A9", reply("escaped"));
          app.get("/twice", (req: any, _res: any, next: any) => ((req.order = ["lower"]), next()));
          app.get("/TWICE", (req: any, res: any) => res.json({ order: [...(req.order ?? []), "upper"] }));
          app.get(/^\/re\/ABC$/, reply("regexp"));
          app.get(/^\/rei\/abc$/i, reply("regexp i"));
          app.use("/Mw", (req: any, res: any, next: any) => (req.query.stop ? res.json({ baseUrl: req.baseUrl, url: req.url }) : next()));
          router.get("/Item/:Id", reply("router item"));
          router.use("/Deep", reply("router middleware"));
          app.use("/Api/:Org", router);
          app.put("/Only-Put", reply("put"));
          // The default 404 pages differ.
          app.use((req: any, res: any) => res.status(404).json({ notFound: req.path }));
        },
        { "case sensitive routing": caseSensitive },
      );
    });

    afterAll(() => Promise.all([pair.express.close(), pair.pype.close()]));

    it.each([
      "/Users/Ada",
      "/users/Ada",
      "/USERS/ada",
      "/files/A/b/C.TXT",
      "/FILES/a",
      "/caf%C3%A9",
      "/CAF%c3%a9",
      "/twice",
      "/TWICE",
      "/Twice",
      "/re/ABC",
      "/re/abc",
      "/rei/ABC",
      "/Mw/x?stop=1",
      "/mw/X?stop=1",
      "/Api/Acme/Item/7",
      "/api/acme/item/7",
      "/API/ACME/ITEM/Seven",
      "/api/Acme/deep/More",
    ])("GET %s", (path) => same(path, {}, pair));

    it.each(["/only-put", "/Only-Put", "/ONLY-PUT"])("OPTIONS %s", (path) => same(path, { method: "OPTIONS" }, pair));
  });

  describe.each([false, true])("strict routing: %s", (strict) => {
    let pair: Pair;

    beforeAll(async () => {
      pair = await startPair(
        (app, kind) => {
          const k = kit(kind);
          // Express's routers have their own option, Pype's setting covers every router.
          const router = k.Router({ strict });
          const reply = (where: string) => (req: any, res: any) =>
            res.json({ where, params: req.params, baseUrl: req.baseUrl, path: req.path, url: req.url });
          app.get("/plain", reply("plain"));
          app.get("/slash/", reply("slash"));
          app.get("/users/:id", reply("user"));
          app.get(kind === "express" ? "/files/*rest" : "/files/*", (req: any, res: any) =>
            res.json({ rest: [req.params.rest ?? req.params["*"]].flat().join("/") }),
          );
          app.use("/mw", (req: any, res: any, next: any) => (req.query.stop ? res.json({ mw: req.url, baseUrl: req.baseUrl }) : next()));
          router.get("/", reply("router root"));
          router.get("/x", reply("router x"));
          router.get("/y/", reply("router y/"));
          app.use("/api", router);
          app.get("/api", reply("app /api after the router"));
          app.use((req: any, res: any) => res.status(404).json({ notFound: req.path }));
        },
        { "strict routing": strict },
      );
    });

    afterAll(() => Promise.all([pair.express.close(), pair.pype.close()]));

    it.each([
      "/plain",
      "/plain/",
      "/slash",
      "/slash/",
      "/users/7",
      "/users/7/",
      "/files/a/b/",
      ...(strict ? [] : ["/files/"]),
      "/mw?stop=1",
      "/mw/?stop=1",
      "/mw/a/?stop=1",
      "/api",
      "/api/",
      "/api/x",
      "/api/x/",
      "/api/y",
      "/api/y/",
      "/",
    ])("GET %s", (path) => same(path, {}, pair));

    it.each(["/plain", "/plain/", "/api", "/api/", "/api/x/"])("OPTIONS %s", (path) => same(path, { method: "OPTIONS" }, pair));

    it.skipIf(!strict)("Pype's * also matches an empty rest, Express 5's *name doesn't", async () => {
      const [fromExpress, fromPype] = await both("/files/", {}, pair);
      expect(fromExpress.status).toBe(404);
      expect(JSON.parse(fromPype.text)).toEqual({ rest: "" });
    });
  });

  it.each(["POST", "PUT", "OPTIONS", "HEAD"])("a param that fails to decode answers 400 for %s too", async (method) => {
    for (const path of ["/params/%ZZ", "/params/%", "/params/%E0%A4%A", "/params/a%20b"]) await same(path, { method });
  });

  it("middleware mounted on a path with params sees them", async () => {
    const pair = await startPair((app) => {
      app.param("org", (req: any, _res: any, next: any, value: string) => {
        req.seen = (req.seen ?? 0) + 1;
        next(value === "blocked" ? Object.assign(new Error("no"), { status: 403 }) : undefined);
      });
      app.use("/orgs/:org/teams/:team", (req: any, res: any) =>
        res.json({ params: req.params, seen: req.seen, baseUrl: req.baseUrl, url: req.url }),
      );
      app.use("/orgs/:org", (req: any, res: any) => res.json({ params: req.params, seen: req.seen, baseUrl: req.baseUrl }));
      app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.status }));
    });
    try {
      for (const path of [
        "/orgs/acme",
        "/orgs/acme/x?y=1",
        "/orgs/caf%C3%A9",
        "/orgs/%ZZ",
        "/orgs/blocked",
        "/orgs/acme/teams/red/members",
        "/orgs/acme/teams/%ZZ",
      ]) {
        for (const method of ["GET", "POST"]) await same(path, { method }, pair);
      }
      // An empty param doesn't match; the 404 pages differ.
      const [fromExpress, fromPype] = await both("/orgs/", {}, pair);
      expect(fromPype.status).toBe(fromExpress.status);
    } finally {
      await Promise.all([pair.express.close(), pair.pype.close()]);
    }
  });
});

describe("body parsers match Express", () => {
  const post = (path: string, body: string | undefined, headers: Record<string, string>) =>
    same(path, { method: "POST", body, headers });

  it.each([
    ['{"a":1}', {}],
    ["[1,2]", {}],
    ['"str"', {}],
    ["42", {}],
    ["null", {}],
    ["{bad", {}],
    ["", {}],
    ["  ", {}],
    ['{"a":1}', { "Transfer-Encoding": "chunked" }],
    [JSON.stringify({ a: "x".repeat(2000) }), {}],
    ['{"a":1}', { "Content-Type": "application/vnd.api+json" }],
    ['{"a":1}', { "Content-Type": "application/json; charset=utf-8" }],
    ['{"a":1}', { "Content-Type": "application/json; charset=latin1" }],
    ['{"a":1}', { "Content-Type": "text/plain" }],
    ['{"__proto__":{"x":1}}', {}],
  ] as const)("json() with body %s and headers %o", (body, headers) =>
    post("/body/json", body, { "Content-Type": "application/json", ...headers }),
  );

  it.each(['"str"', "42", "null", "true", " [1] "])("json({ strict: false }) with %s", (body) =>
    post("/body/json-loose", body, { "Content-Type": "application/json" }),
  );

  it.each([
    "a=1&b=2",
    "a=1&a=2",
    "a[b]=c",
    "a=%20b+c",
    "",
    "__proto__=x",
    "a=%zz",
    "=x&y",
    "[]=1&[]=2",
    "[]",
    "[a]=1",
    "[a]=1&a=2&a=3",
    "0=a&[]=b",
    "[]=a&0=b",
    "[__proto__]=x",
    "%5Ba%5D=1",
    "a]=b=c",
    "[05]=x&[5]=y",
    "&&a=1&&",
  ])(
    "urlencoded() with %s",
    (body) => post("/body/form", body, { "Content-Type": "application/x-www-form-urlencoded" }),
  );

  it.each(["hello", "", "héllo"])("text() with %s", (body) => post("/body/text", body, { "Content-Type": "text/plain" }));

  it("raw() reads bytes", () => post("/body/raw", "\u0000\u0001binary", { "Content-Type": "application/octet-stream" }));

  it("skips requests without a body", () => same("/body/json", { method: "POST", headers: { "Content-Type": "application/json" } }));
});

describe("files match Express", () => {
  it.each([
    "/file/hello.txt",
    "/file/empty.txt",
    "/file/docs/readme.md",
    "/file/missing.txt",
    "/file/docs",
    "/file/.secret",
    "/file/..%2Fetc%2Fpasswd",
    "/file/%2e%2e/etc/passwd",
    "/file/%252e%252e/etc/passwd",
    "/file/docs/..%2F..%2Fsecret",
    "/file/....//hello.txt",
    "/file/hello.txt%00.png",
    "/file/hello.txt/",
    "/file/docs/",
    "/file/site/",
    "/file/site",
    "/file/alt/",
    "/file-no-index/site/",
    "/file-no-index/hello.txt/",
    "/file-no-index/hello.txt",
    "/file-custom-index/alt/",
    "/file-custom-index/site/",
    "/file-custom-index/docs/",
    "/file/HELLO.TXT",
    "/download",
  ])("GET %s", (path) => same(path));

  it.each(["bytes=0-4", "bytes=-5", "bytes=6-", "bytes=50-60", "bytes=0-1,3-4", "bytes=garbage", "items=0-1"])(
    "GET /file/hello.txt with Range: %s",
    (range) => same("/file/hello.txt", { headers: { Range: range } }),
  );

  it.each(["bytes=0-0", "bytes=-1", "bytes=0-"])("GET /file/empty.txt with Range: %s", (range) =>
    same("/file/empty.txt", { headers: { Range: range } }),
  );

  it("HEAD and conditional GET of a file", async () => {
    await same("/file/hello.txt", { method: "HEAD" });
    const lastModified = (await servers.express.send("/file/hello.txt")).headers["last-modified"] as string;
    await same("/file/hello.txt", { headers: { "If-Modified-Since": lastModified } });
  });

  it("If-Match, If-Unmodified-Since and If-Range on a file", async () => {
    const { etag, "last-modified": lastModified } = (await servers.express.send("/file/hello.txt")).headers;
    const epoch = "Thu, 01 Jan 1970 00:00:00 GMT";
    const range = { Range: "bytes=0-4" };
    for (const headers of <Record<string, string>[]>[
      { "If-Match": etag! },
      { "If-Match": `"other", ${etag}` },
      { "If-Match": '"other"' },
      { "If-Match": "*" },
      { "If-Unmodified-Since": lastModified! },
      { "If-Unmodified-Since": epoch },
      { "If-Unmodified-Since": "garbage" },
      { ...range, "If-Range": etag! },
      { ...range, "If-Range": '"other"' },
      { ...range, "If-Range": lastModified! },
      { ...range, "If-Range": epoch },
      { ...range, "If-Range": "garbage" },
    ]) {
      await same("/file/hello.txt", { headers });
    }
  });
});

describe("body parser edge cases match Express", () => {
  const post = (path: string, body: string | Buffer, headers: Record<string, string>) =>
    same(path, { method: "POST", body, headers });

  it("json() with a UTF-16 body", () =>
    post("/body/json", Buffer.from('{"a":"ü"}', "utf16le"), { "Content-Type": "application/json; charset=utf-16le" }));

  const utf32 = (text: string, bigEndian: boolean, bom: boolean) => {
    const points = [...(bom ? "\ufeff" : ""), ...text].map((char) => char.codePointAt(0)!);
    const buffer = Buffer.alloc(points.length * 4);
    points.forEach((point, i) => (bigEndian ? buffer.writeUInt32BE(point, i * 4) : buffer.writeUInt32LE(point, i * 4)));
    return buffer;
  };

  it.each([
    ["utf-32le", false, false],
    ["utf-32le", false, true],
    ["utf-32be", true, false],
    ["utf-32be", true, true],
    ["utf-32", false, false],
    ["utf-32", false, true],
    ["utf-32", true, true],
  ] as const)("json() with %s, big endian %s, BOM %s", (charset, bigEndian, bom) =>
    post("/body/json", utf32('{"a":"ü😀"}', bigEndian, bom), { "Content-Type": `application/json; charset=${charset}` }));

  it("text() with UTF-32 that has invalid code points and trailing bytes", () =>
    post("/body/text", Buffer.concat([utf32("ok", false, false), Buffer.from([0x00, 0x00, 0x11, 0x00, 0x01])]), {
      "Content-Type": "text/plain; charset=utf-32le",
    }));

  it("json() with a byte order mark", () =>
    post("/body/json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]), {
      "Content-Type": "application/json",
    }));

  it.each(["utf-32", "utf-8x", "UTF-8", '"utf-8"', "iso-8859-1"])("json() with charset %s", (charset) =>
    post("/body/json", '{"a":1}', { "Content-Type": `application/json; charset=${charset}` }));

  it("json() with Content-Length: 0", () =>
    post("/body/json", "", { "Content-Type": "application/json", "Content-Length": "0" }));

  it("json() with an unknown Content-Encoding", () =>
    post("/body/json", '{"a":1}', { "Content-Type": "application/json", "Content-Encoding": "foo" }));

  describe("compressed bodies", () => {
    const json = '{"a":"compressed ü"}';
    const zlib = require("zlib") as typeof import("zlib");
    const cases: [string, Buffer, string][] = [
      ["gzip", zlib.gzipSync(json), "gzip"],
      ["deflate", zlib.deflateSync(json), "deflate"],
      ["br", zlib.brotliCompressSync(json), "br"],
      ["upper-case GZIP", zlib.gzipSync(json), "GZIP"],
      ["x-gzip", zlib.gzipSync(json), "x-gzip"],
      ["a list of encodings", zlib.gzipSync(json), "gzip, identity"],
      ["identity", Buffer.from(json), "identity"],
      ["corrupt gzip", Buffer.from("not gzip at all"), "gzip"],
      ["truncated gzip", zlib.gzipSync(json).subarray(0, 10), "gzip"],
      ["raw deflate sent as deflate", zlib.deflateRawSync(json), "deflate"],
      ["gzip sent as br", zlib.gzipSync(json), "br"],
      ["gzip over the 1kb limit", zlib.gzipSync(JSON.stringify({ a: "x".repeat(5000) })), "gzip"],
      ["empty gzip", zlib.gzipSync(""), "gzip"],
    ];

    it.each(cases)("json() with %s", (_name, body, encoding) =>
      post("/body/json", body, { "Content-Type": "application/json", "Content-Encoding": encoding }));

    it.each(cases)("json({ inflate: false }) with %s", (_name, body, encoding) =>
      post("/body/json-no-inflate", body, { "Content-Type": "application/json", "Content-Encoding": encoding }));

    it("urlencoded() and text() with gzip, and a latin1 charset inside", async () => {
      await post("/body/form", zlib.gzipSync("a=1&b=%C3%A9"), {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Encoding": "gzip",
      });
      await post("/body/text", zlib.gzipSync(Buffer.from("café", "latin1")), {
        "Content-Type": "text/plain; charset=iso-8859-1",
        "Content-Encoding": "gzip",
      });
      await post("/body/raw", zlib.deflateSync(Buffer.alloc(100, 1)), {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "deflate",
      });
    });
  });

  it.each(["iso-8859-1", "utf-8", "latin1", "utf-16"])("urlencoded() with charset %s", (charset) =>
    post("/body/form", Buffer.from("name=caf%E9&raw=é", "latin1"), {
      "Content-Type": `application/x-www-form-urlencoded; charset=${charset}`,
    }));

  it("urlencoded() with 1000 and 1001 parameters", async () => {
    const params = (count: number) => Array.from({ length: count }, (_, i) => `k${i}=${i}`).join("&");
    await post("/body/form", params(1000), { "Content-Type": "application/x-www-form-urlencoded" });
    await post("/body/form", params(1001), { "Content-Type": "application/x-www-form-urlencoded" });
  });

  it.each([
    ["text/plain; charset=iso-8859-1", Buffer.from("café", "latin1")],
    ["text/plain; charset=utf-16le", Buffer.from("hé", "utf16le")],
    ["text/plain; charset=windows-1252", Buffer.from([0x80])],
    ["text/plain; charset=foo", Buffer.from("x")],
  ] as const)("text() with %s", (type, body) => post("/body/text", body, { "Content-Type": type }));

  it("text() and raw() with Content-Length: 0", async () => {
    await post("/body/text", "", { "Content-Type": "text/plain", "Content-Length": "0" });
    await post("/body/raw", "", { "Content-Type": "application/octet-stream", "Content-Length": "0" });
  });
});

describe("etag and json settings match Express", () => {
  const body = { html: "<script>alert('&')</script>", n: 1 };
  const define = (app: any) => {
    app.get("/text", (_req: any, res: any) => res.send("hello world"));
    app.get("/empty", (_req: any, res: any) => res.send(""));
    app.get("/buffer", (_req: any, res: any) => res.send(Buffer.from("bytes")));
    app.get("/json", (_req: any, res: any) => res.json(body));
    app.get("/setting", (_req: any, res: any) => res.json({ etag: app.get("etag"), escape: app.get("json escape") ?? null }));
  };

  it.each<[string, Record<string, unknown>]>([
    ["defaults", {}],
    ["etag strong", { etag: "strong" }],
    ["etag weak", { etag: "weak" }],
    ["etag true", { etag: true }],
    ["etag false", { etag: false }],
    ["etag function", { etag: (chunk: string | Buffer, encoding?: string) => `"custom-${Buffer.byteLength(chunk)}-${encoding ?? "buffer"}"` }],
    ["json escape", { "json escape": true }],
    ["json escape with spaces and a replacer", { "json escape": true, "json spaces": 2, "json replacer": (k: string, v: unknown) => (k === "n" ? undefined : v) }],
  ])("%s", async (_name, settings) => {
    const pair = await startPair(define, settings);
    try {
      for (const path of ["/text", "/empty", "/buffer", "/json", "/setting"]) await same(path, {}, pair);
      const etag = (await pair.express.send("/text")).headers.etag as string | undefined;
      if (etag) await same("/text", { headers: { "If-None-Match": etag } }, pair);
    } finally {
      await Promise.all([pair.express.close(), pair.pype.close()]);
    }
  });

  it("rejects an unknown etag value like Express", () => {
    expect(() => express().set("etag", "medium")).toThrow("unknown value for etag function: medium");
    expect(() => new Pype().set("etag", "medium")).toThrow("unknown value for etag function: medium");
  });
});

describe("every HTTP method matches Express", () => {
  let pair: Pair;
  const methods = ["PURGE", "PROPFIND", "SEARCH", "TRACE", "QUERY", "LOCK", "MKCOL", "M-SEARCH", "REPORT"];

  beforeAll(async () => {
    pair = await startPair((app, kind) => {
      const k = kit(kind);
      const reply = (where: string) => (req: any, res: any) => res.json({ where, method: req.method, params: req.params });
      app.purge("/cache/:key", reply("app.purge"));
      app.propfind("/dav", reply("app.propfind"));
      app["m-search"]("/ssdp", reply("app.m-search"));
      app.all("/any", reply("app.all"));
      app.route("/chain").search(reply("route.search")).report(reply("route.report"));
      const router = k.Router();
      router.lock("/file", reply("router.lock"));
      router.mkcol("/dir", reply("router.mkcol"));
      app.use("/r", router);
      app.get("/get-only", reply("get"));
      app.use((req: any, res: any) => res.status(404).json({ notFound: `${req.method} ${req.path}` }));
    });
  });

  afterAll(() => Promise.all([pair.express.close(), pair.pype.close()]));

  it.each(methods)("%s requests", async (method) => {
    for (const path of ["/cache/abc", "/dav", "/ssdp", "/any", "/chain", "/r/file", "/r/dir", "/get-only"]) {
      await same(path, { method }, pair);
    }
  });

  it.each(["/cache/abc", "/dav", "/chain", "/r/file", "/any"])("automatic OPTIONS lists them: %s", (path) =>
    same(path, { method: "OPTIONS" }, pair),
  );
});

describe("automatic OPTIONS matches Express", () => {
  let pair: Pair;

  beforeAll(async () => {
    pair = await startPair((app) => {
      app.use((_req: any, res: any, next: any) => {
        res.set("X-Test", "middleware ran");
        next();
      });
      app.get("/x", (_req: any, res: any) => res.send("x"));
      app.post("/x", (_req: any, res: any) => res.send("x"));
      app.delete("/x", (_req: any, res: any) => res.send("x"));
      app.get("/params/:id", (_req: any, res: any) => res.send("p"));
      app.put("/put-only", (_req: any, res: any) => res.send("put"));
      app.options("/explicit", (_req: any, res: any) => res.status(204).set("Allow", "CUSTOM").end());
      app.get("/explicit", (_req: any, res: any) => res.send("get"));
      app.options("/explicit-next", (_req: any, _res: any, next: any) => next());
      app.get("/explicit-next", (_req: any, res: any) => res.send("get"));
      app.all("/all", (_req: any, _res: any, next: any) => next());
    });
  });

  afterAll(async () => {
    await Promise.all([pair.express.close(), pair.pype.close()]);
  });

  it.each(["/x", "/params/1", "/put-only", "/explicit", "/explicit-next", "/x?query=1", "/x/"])("OPTIONS %s", (path) =>
    same(path, { method: "OPTIONS" }, pair),
  );

  it("each router answers OPTIONS for its own routes when it is done, before later middleware", async () => {
    const nested = await startPair((app, kind) => {
      const k = kit(kind);
      const router = k.Router();
      const inner = k.Router();
      inner.patch("/z", (_req: any, res: any) => res.send("patch"));
      router.put("/y", (_req: any, res: any) => res.send("put"));
      router.use("/in", inner);
      router.get("/leave", (_req: any, _res: any, next: any) => next());
      router.use("/leave", (_req: any, _res: any, next: any) => next("router"));
      router.post("/leave", (_req: any, res: any) => res.send("post"));
      app.use("/r", router);
      app.get("/r/y", (_req: any, res: any) => res.send("get"));
      app.delete("/r/in/z", (_req: any, res: any) => res.send("delete"));
      app.use((_req: any, res: any) => res.status(404).send("catch-all 404"));
    });
    for (const path of ["/r/y", "/r/in/z", "/r/leave", "/r/none"]) await same(path, { method: "OPTIONS" }, nested);
    await Promise.all([nested.express.close(), nested.pype.close()]);
  });

  it.each(["/missing", "/all"])("OPTIONS %s without a route answers 404 in both", async (path) => {
    const [fromExpress, fromPype] = await both(path, { method: "OPTIONS" }, pair);
    expect(fromExpress.status).toBe(404);
    expect(fromPype.status).toBe(404);
    expect(fromPype.headers.allow).toBeUndefined();
  });
});

describe("trust proxy matches Express", () => {
  const TRUST: unknown[] = [
    false,
    true,
    0,
    1,
    2,
    "loopback",
    "127.0.0.1",
    "::ffff:127.0.0.1",
    "10.0.0.1",
    "127.0.0.1, 10.0.0.1",
    "loopback, 10.0.0.0/8",
    ["loopback", "10.0.0.5"],
    "uniquelocal",
  ];

  const REQUESTS: Record<string, string>[] = [
    { Host: "app.example.com" },
    { Host: "app.example.com:8080" },
    { Host: "[::1]:3000" },
    { Host: "a.b.app.example.com" },
    { Host: "127.0.0.1:3000" },
    { Host: "app.example.com", "X-Forwarded-For": "1.1.1.1" },
    { Host: "app.example.com", "X-Forwarded-For": "1.1.1.1, 10.0.0.1" },
    { Host: "app.example.com", "X-Forwarded-For": "2.2.2.2, 1.1.1.1, 10.0.0.5" },
    { Host: "app.example.com", "X-Forwarded-For": "spoofed, 10.0.0.5" },
    { Host: "app.example.com", "X-Forwarded-For": " 1.1.1.1 ,, 10.0.0.1 " },
    { Host: "app.example.com", "X-Forwarded-For": "::ffff:10.0.0.1" },
    { Host: "app.example.com", "X-Forwarded-Proto": "https" },
    { Host: "app.example.com", "X-Forwarded-Proto": "https, http" },
    { Host: "app.example.com", "X-Forwarded-Proto": " HTTP " },
    { Host: "app.example.com", "X-Forwarded-Host": "evil.example" },
    { Host: "app.example.com", "X-Forwarded-Host": "evil.example:9000, app.example.com" },
    { Host: "app.example.com", "X-Forwarded-Host": "[::1]:9000" },
    { Host: "app.example.com", "X-Forwarded-For": "1.1.1.1", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "a.b.example.org" },
  ];

  for (const trust of TRUST) {
    describe(`trust proxy = ${JSON.stringify(trust)}`, () => {
      let pair: Pair;

      beforeAll(async () => {
        pair = await startPair(
          (app) => {
            app.get("/whoami", (req: any, res: any) =>
              res.json({
                ip: req.ip,
                ips: req.ips,
                protocol: req.protocol,
                secure: req.secure,
                hostname: req.hostname,
                host: req.host,
                subdomains: req.subdomains,
              }),
            );
          },
          { "trust proxy": trust },
        );
      });

      afterAll(async () => {
        await Promise.all([pair.express.close(), pair.pype.close()]);
      });

      it.each(REQUESTS)("with headers %o", (headers) => same("/whoami", { headers }, pair));
    });
  }
});

describe("documented differences from Express", () => {
  it("Pype sends X-Powered-By only when the setting is on", async () => {
    for (const settings of [{}, { "x-powered-by": true }, { "x-powered-by": false }]) {
      const pair = await startPair((app) => app.get("/", (_req: any, res: any) => res.send("ok")), settings);
      const [fromExpress, fromPype] = await both("/", {}, pair);
      await Promise.all([pair.express.close(), pair.pype.close()]);

      const on = (settings as any)["x-powered-by"];
      expect(fromExpress.headers["x-powered-by"]).toBe(on === false ? undefined : "Express");
      expect(fromPype.headers["x-powered-by"]).toBe(on === true ? "Pype" : undefined);
    }
  });

  // Each of these is listed under "Differences" in the README. The test
  // fails if the behaviour changes, so the README can be updated with it.

  it("Pype ignores duplicate slashes, Express doesn't match them", async () => {
    const [fromExpress, fromPype] = await both("/api//admin//users/7");
    expect(fromExpress.status).toBe(404);
    expect(JSON.parse(fromPype.text)).toMatchObject({ id: "7", baseUrl: "/api/admin", path: "/users/7" });
  });

  it("Pype ignores a second next() call, Express continues with the following layer", async () => {
    const hits: Record<Kind, number> = { express: 0, pype: 0 };
    const pair = await startPair((app, kind) => {
      app.get("/double", (_req: any, _res: any, next: any) => {
        next();
        next();
      });
      app.use((_req: any, res: any) => res.send("once"));
      app.use((_req: any, _res: any) => {
        hits[kind]++;
      });
    });
    const [fromExpress, fromPype] = await both("/double", {}, pair);
    await Promise.all([pair.express.close(), pair.pype.close()]);

    expect(fromExpress.text).toBe("once");
    expect(fromPype.text).toBe("once");
    expect(hits).toEqual({ express: 1, pype: 0 });
  });

  it("sendFile errors carry a standard message, Express passes the file system error", async () => {
    // Pype's final handler shows 4xx messages, so it must not contain the path.
    const pair = await startPair((app) => {
      app.get("/missing", (_req: any, res: any) => res.sendFile(join(root, "missing.txt")));
      app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status).json({ message: err.message, code: err.code }));
    });
    const [fromExpress, fromPype] = await both("/missing", {}, pair);
    await Promise.all([pair.express.close(), pair.pype.close()]);

    expect(fromPype.status).toBe(fromExpress.status);
    expect(JSON.parse(fromExpress.text).message).toContain(root);
    expect(JSON.parse(fromPype.text)).toEqual({ message: "Not Found", code: "ENOENT" });
  });


});

describe("fuzzing against Express", () => {
  /** Header-safe text built from pieces that matter to each parser. */
  const headerFrom = (...pieces: string[]) =>
    fc
      .array(fc.constantFrom(...pieces), { maxLength: 8 })
      .map((parts) => parts.join(""))
      .filter((value) => /^[\x20-\x7e]*$/.test(value) && value.trim() === value);

  const property = (arbitrary: fc.Arbitrary<string>, request: (value: string) => [string, SendOptions]) =>
    fc.assert(
      fc.asyncProperty(arbitrary, async (value) => {
        const [path, options] = request(value);
        await same(path, options);
      }),
      { numRuns: RUNS },
    );

  it("Accept and res.format()", () =>
    property(
      headerFrom("text/html", "application/json", "text/*", "*/*", "image/png", "*", ";q=0", ";q=0.5", ";q=1", ";level=1", ", ", ",", " ", '"', "x"),
      (accept) => [Math.random() < 0.5 ? "/accepts" : "/format", { headers: { Accept: accept } }],
    ));

  it("Accept-Encoding", () =>
    property(headerFrom("gzip", "br", "identity", "*", ";q=0", ";q=0.3", ", ", ",", " ", "GZIP"), (value) => [
      "/encodings",
      { headers: { "Accept-Encoding": value } },
    ]));

  it("Accept-Language and Accept-Charset", () =>
    property(headerFrom("en", "en-US", "en-GB", "fr", "-", "*", ";q=0", ";q=0.7", ", ", "utf-8", "UTF-8"), (value) => [
      Math.random() < 0.5 ? "/languages" : "/charsets",
      { headers: { "Accept-Language": value, "Accept-Charset": value } },
    ]));

  it("Range", () =>
    property(headerFrom("bytes=", "0", "5", "99", "999", "1000", "-", ",", " ", "x", "items="), (range) => [
      "/range",
      { headers: { Range: range } },
    ]));

  it("If-None-Match and If-Modified-Since", () =>
    property(
      headerFrom('"v1"', 'W/"v1"', '"v2"', "*", ", ", ",", " ", "Thu, 01 Jan 2026 00:00:00 GMT", "garbage"),
      (value) => ["/fresh", { headers: { "If-None-Match": value, "If-Modified-Since": value } }],
    ));

  it("Cookie", () =>
    property(headerFrom("a=b", "; ", ";", "=", "j%3A%7B%7D", "j:", "s%3Avalue.sig", "%", " ", "\"q\"", "x"), (cookie) => [
      "/cookie/read",
      { headers: { Cookie: cookie } },
    ]));

  it("query strings", () =>
    property(headerFrom("a", "b", "=", "&", "%20", "%", "%zz", "+", "[", "]", "__proto__", "?"), (query) => [
      `/props?${query}`,
      {},
    ]));

  it("urlencoded bodies", () =>
    property(headerFrom("a", "b", "=", "&", "%20", "%", "%zz", "+", "[", "]", "__proto__", ""), (body) => [
      "/body/form",
      { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    ]));

  it("JSON bodies", () =>
    property(headerFrom("{", "}", "[", "]", '"a"', ":", "1", ",", " ", "null", "true", "\\n"), (body) => [
      Math.random() < 0.5 ? "/body/json" : "/body/json-loose",
      { method: "POST", body, headers: { "Content-Type": "application/json" } },
    ]));

  it("Content-Type for req.is()", () =>
    property(headerFrom("application", "text", "/", "json", "html", "+json", "vnd.x", "*", ";", " ", "charset=utf-8", "x"), (type) => [
      "/is",
      { method: "POST", body: "x", headers: { "Content-Type": type } },
    ]));
});

describe("extended forms, query parsers and body-parser options match Express", () => {
  let pair: Pair;
  const queryPairs: Partial<Record<string, Pair>> = {};

  /** Nested keys, arrays past the limit, depth, prototypes and odd brackets. */
  const NESTED = [
    "a[b][c]=1&a[b][d]=2",
    "x[]=1&x[]=2&x[]=3",
    "y[0]=a&y[2]=c&y[1]=b",
    "z[a]=1&z=2",
    "z=2&z[a]=1",
    "m[1000]=x&m[1]=y",
    "n[]=",
    "deep[a][b][c][d][e][f][g]=1",
    "a[]=1&a[]=2&a[5]=x",
    "a[b]=1&a[]=2",
    "a[]=1&a[b]=2",
    "a[0][b]=1&a[0][c]=2&a[1][b]=3",
    "__proto__[x]=1&a[__proto__][y]=2&constructor[prototype][z]=3",
    "hasOwnProperty=1&toString[x]=2",
    "a[b=1",
    "a]b[=1",
    "a[[b]]=1",
    "a[b]c=1",
    "[a]=1&[]=2",
    "a.b=1",
    "a=%5Bx%5D&b%5Bc%5D=1",
    "a=1&a=2&a[]=3",
    Array.from({ length: 25 }, (_, i) => `big[]=${i}`).join("&"),
    Array.from({ length: 150 }, (_, i) => `huge[]=${i}`).join("&"),
  ];

  beforeAll(async () => {
    pair = await startPair((app, kind) => {
      const k = kit(kind);
      const reply = (req: any, res: any) => res.json({ body: req.body ?? "missing" });
      app.post("/extended", k.urlencoded({ extended: true }), reply);
      app.post("/flat", k.urlencoded({ extended: false }), reply);
      app.post("/limit", k.urlencoded({ extended: true, parameterLimit: 3 }), reply);
      app.post("/depth", k.urlencoded({ extended: true, depth: 2 }), reply);
      app.post("/sentinel", k.urlencoded({ extended: true, charsetSentinel: true, interpretNumericEntities: true }), reply);
      app.post("/latin1", k.urlencoded({ defaultCharset: "iso-8859-1" }), reply);
      app.post("/text-latin1", k.text({ defaultCharset: "iso-8859-1" }), reply);
      app.post(
        "/verify",
        k.json({
          verify: (_req: any, _res: any, body: Buffer, charset: string) => {
            if (body.includes("forbidden")) throw Object.assign(new Error("verify failed"), { type: body.includes("typed") ? "custom.type" : undefined });
            if (charset !== "utf-8") throw new Error(`charset ${charset}`);
          },
        }),
        reply,
      );
      app.post("/raw-verify", k.raw({ verify: (_req: any, _res: any, _body: Buffer, charset: any) => {
        if (charset !== null && charset !== undefined) throw new Error(`charset ${charset}`);
      } }), (req: any, res: any) => res.json({ length: req.body.length }));
      app.post("/reviver", k.json({ reviver: (key: string, value: any) => (key === "n" ? value * 2 : value) }), reply);
      app.use((err: any, _req: any, res: any, _next: any) =>
        res.status(err.status || 500).json({ status: err.status, type: err.type ?? null, message: err.message }),
      );
    });

    for (const setting of ["simple", "extended", false, true]) {
      queryPairs[String(setting)] = await startPair(
        (app) => app.get("/q", (req: any, res: any) => res.json({ query: req.query })),
        { "query parser": setting },
      );
    }
  });

  afterAll(async () => {
    await Promise.all(
      [pair, ...Object.values(queryPairs)].flatMap((p) => [p!.express.close(), p!.pype.close()]),
    );
  });

  const form = (path: string, body: string | Buffer, type = "application/x-www-form-urlencoded") =>
    same(path, { method: "POST", body, headers: { "Content-Type": type } }, pair);

  it.each(NESTED)("urlencoded({ extended: true }) with %s", (body) => form("/extended", body));
  it.each(NESTED)("urlencoded({ extended: false }) with %s", (body) => form("/flat", body));

  it.each(["a=1&b=2&c=3", "a=1&b=2&c=3&d=4", "a[b][c]=1", "a[b][c][d]=1", "a[b]=1&c[d][e][f]=2"])(
    "parameterLimit and depth with %s",
    async (body) => {
      await form("/limit", body);
      await form("/depth", body);
    },
  );

  it.each([
    "utf8=%E2%9C%93&a=%C3%A9",
    "utf8=%26%2310003%3B&a=%E9&b=%26%2310003%3B",
    "a=%E9&utf8=%E2%9C%93",
    "utf8=other&a=1",
  ])("charsetSentinel and interpretNumericEntities with %s", (body) => form("/sentinel", body));

  it("defaultCharset for urlencoded() and text()", async () => {
    await form("/latin1", "a=%E9");
    await same("/text-latin1", { method: "POST", body: Buffer.from("café", "latin1"), headers: { "Content-Type": "text/plain" } }, pair);
  });

  it.each([
    ['{"ok":1}', "application/json"],
    ['{"forbidden":1}', "application/json"],
    ['{"forbidden typed":1}', "application/json"],
    ['{"ok":1}', "application/json; charset=utf-16le"],
  ])("verify with %s as %s", (body, type) =>
    same("/verify", { method: "POST", body: type.includes("16") ? Buffer.from(body, "utf16le") : body, headers: { "Content-Type": type } }, pair));

  it("verify of raw() gets no charset, and reviver transforms values", async () => {
    await same("/raw-verify", { method: "POST", body: "abc", headers: { "Content-Type": "application/octet-stream" } }, pair);
    await same("/reviver", { method: "POST", body: '{"n":21,"m":[{"n":1}]}', headers: { "Content-Type": "application/json" } }, pair);
  });

  it("invalid options throw like body-parser", () => {
    const throwsSame = (create: (k: any) => unknown) => {
      const message = (kind: Kind) => {
        try {
          create(kit(kind));
          return "no error";
        } catch (error) {
          return (error as Error).constructor.name + ": " + (error as Error).message;
        }
      };
      expect(message("pype")).toBe(message("express"));
    };
    throwsSame((k) => k.urlencoded({ defaultCharset: "utf-16" }));
    throwsSame((k) => k.urlencoded({ parameterLimit: 0 }));
    throwsSame((k) => k.urlencoded({ extended: true, depth: -1 }));
    throwsSame((k) => k.json({ verify: "nope" }));
  });

  it.each([...NESTED, "", "a", "a=1&a=2", "%zz=1", "a=%zz", "a=b=c", "a[]=1&a[]=2&a[]=3&a[]=4"])(
    "req.query with every query parser setting for ?%s",
    async (query) => {
      for (const p of Object.values(queryPairs)) await same(`/q?${query}`, {}, p);
    },
  );

  it("req.query without a question mark", async () => {
    for (const p of Object.values(queryPairs)) await same("/q", {}, p);
  });

  it("an unknown query parser throws like Express", () => {
    expect(() => new Pype().set("query parser", "fancy")).toThrow("unknown value for query parser function: fancy");
    expect(() => express().set("query parser", "fancy")).toThrow("unknown value for query parser function: fancy");
  });

  it("a custom query parser gets the raw query string, null without one", async () => {
    const seen: Record<Kind, unknown[]> = { express: [], pype: [] };
    const custom = await startPair((app, kind) => {
      app.set("query parser", (query: string | null) => {
        seen[kind].push(query);
        return { custom: query };
      });
      app.get("/q", (req: any, res: any) => res.json(req.query));
    });
    await same("/q?a=1&b", {}, custom);
    await same("/q", {}, custom);
    await same("/q?", {}, custom);
    await Promise.all([custom.express.close(), custom.pype.close()]);
    expect(seen.pype).toEqual(["a=1&b", null, ""]);
    expect(seen.express).toEqual(seen.pype);
  });

  it("fuzzed nested forms and queries", () => {
    const piece = fc.constantFrom("a", "b", "0", "1", "[", "]", "[]", "=", "&", "%5B", "%5D", "x", "__proto__", ".");
    return fc.assert(
      fc.asyncProperty(fc.array(piece, { maxLength: 12 }).map((p) => p.join("")), async (value) => {
        await form("/extended", value);
        await same(`/q?${value}`, {}, queryPairs.extended!);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("app.param() and route errors match Express", () => {
  let pair: Pair;

  beforeAll(async () => {
    pair = await startPair((app, kind) => {
      const k = kit(kind);
      const log = (req: any, entry: string) => (req.log ??= []).push(entry);
      const reply = (req: any, res: any) => res.json({ params: req.params, log: req.log ?? [], user: req.user ?? null });

      app.param("id", (req: any, _res: any, next: any, value: string, name: string) => {
        log(req, `id:${value}:${name}`);
        if (value === "boom") return next(Object.assign(new Error("bad id"), { status: 400 }));
        if (value === "skip") return next("route");
        if (value === "throw") throw Object.assign(new Error("thrown"), { status: 422 });
        req.user = { id: value };
        next();
      });
      app.param("id", (req: any, _res: any, next: any, value: string) => {
        log(req, `id2:${value}`);
        next();
      });
      app.param("slug", async (req: any, _res: any, _next: any, value: string) => {
        log(req, `slug:${value}`);
        if (value === "reject") throw Object.assign(new Error("rejected"), { status: 409 });
        if (value === "plain-reject") return Promise.reject();
        req.params.slug = value.toUpperCase();
        _next();
      });
      app.param(["a", "b"], (req: any, _res: any, next: any, value: string, name: string) => {
        log(req, `${name}=${value}`);
        next();
      });

      app.get("/users/:id", (req: any, _res: any, next: any) => {
        log(req, "first route");
        next();
      });
      app.get("/users/:id", reply);
      app.get("/users/:id", (_req: any, res: any) => res.send("route after skip"));
      app.get("/users/:id/again/:id2", reply);
      app.get("/posts/:slug", reply);
      app.get("/pair/:a/:b", reply);
      app.get("/no-params", reply);
      // Express 5 writes optional params as {/:id}, Pype as :id?.
      app.get(kind === "express" ? "/optional{/:id}" : "/optional/:id?", reply);

      const router = k.Router();
      router.param("rid", (req: any, _res: any, next: any, value: string) => {
        log(req, `rid:${value}`);
        next();
      });
      router.get("/:rid", reply);
      router.get("/:rid/:id", reply);
      app.use("/sub", router);

      // A pending error skips routes, their error handlers included.
      app.use("/pending", (_req: any, _res: any, next: any) => next(Object.assign(new Error("early"), { status: 418 })));
      app.get("/pending", reply, (err: any, _req: any, res: any, _next: any) => res.send(`route error handler: ${err.message}`));
      app.get(
        "/inside",
        () => {
          throw Object.assign(new Error("inside"), { status: 451 });
        },
        (err: any, _req: any, res: any, _next: any) => res.send(`route error handler: ${err.message}`),
      );

      app.use((_req: any, res: any) => res.status(404).json({ notFound: true }));
      app.use((err: any, req: any, res: any, _next: any) =>
        res.status(err.status || 500).json({ error: err.message, log: req.log ?? [] }),
      );
    });
  });

  afterAll(async () => {
    await Promise.all([pair.express.close(), pair.pype.close()]);
  });

  it.each([
    "/users/42",
    "/users/boom",
    "/users/skip",
    "/users/throw",
    "/users/a%20b",
    "/users/7/again/8",
    "/posts/hello",
    "/posts/reject",
    "/posts/plain-reject",
    "/pair/1/2",
    "/no-params",
    "/optional",
    "/optional/5",
    "/sub/r1",
    "/sub/r1/9",
    "/pending",
    "/inside",
  ])("GET %s", (path) => same(path, {}, pair));

  it("param() validates its arguments like Express", () => {
    const message = (fn: () => unknown) => {
      try {
        fn();
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    };
    for (const args of [[""], [1], ["id"], ["id", "not a function"]] as unknown[][]) {
      const fromPype = message(() => (new Pype().param as any)(...args));
      const fromExpress = message(() => (express().param as any)(...args));
      expect(fromPype).toBe(fromExpress);
    }
  });
});

describe("regular expression and array paths match Express", () => {
  let pair: Pair;

  beforeAll(async () => {
    pair = await startPair((app, kind) => {
      const k = kit(kind);
      const reply = (req: any, res: any) =>
        res.json({
          params: req.params,
          route: [req.route.path].flat().map(String),
          path: req.path,
          baseUrl: req.baseUrl,
          url: req.url,
          log: req.log ?? [],
        });

      app.param("0", (req: any, _res: any, next: any, value: string) => {
        (req.log ??= []).push(`param 0=${value}`);
        next();
      });

      app.get(/^\/re\/(\d+)$/, reply);
      app.get(/\/(?<name>[a-z]+)-(\d+)/, reply);
      app.get(/^\/opt\/(a)?(b)?$/, reply);
      app.get(/^\/dec\/(.+)$/, reply);
      app.post(/^\/re\/(\d+)$/, reply);
      app.get(["/one", "/two/:id", /^\/three$/], reply);
      app.get(["/dup", "/:any"], (req: any, _res: any, next: any) => {
        (req.log ??= []).push("array route ran");
        next();
      });
      app.get("/dup", reply);
      app.route(/^\/chain$/).get(reply).put(reply);

      app.use(/^\/mw\/(\w+)/, (req: any, res: any, next: any) => {
        if (req.query.next) return next();
        res.json({ params: req.params, path: req.path, baseUrl: req.baseUrl, url: req.url, log: req.log ?? [] });
      });
      app.use(["/multi-a", "/multi-b"], (req: any, res: any) =>
        res.json({ baseUrl: req.baseUrl, path: req.path, params: req.params }),
      );
      app.use(["/twice", "/twice/inner"], (req: any, _res: any, next: any) => {
        (req.log ??= []).push(`mounted at ${req.baseUrl}`);
        next();
      });
      app.get("/twice/inner/x", reply);

      const router = k.Router();
      router.get(/^\/r-(\d+)$/, reply);
      router.use(/^\/inner-(\w+)/, (req: any, res: any) => res.json({ baseUrl: req.baseUrl, path: req.path, params: req.params }));
      app.use(["/routed", "/also-routed"], router);

      app.get("/after-route/:id", (_req: any, _res: any, next: any) => next());
      app.use("/after-route", (req: any, res: any) => res.json({ paramsInMiddleware: req.params }));

      app.use((_req: any, res: any) => res.status(404).json({ notFound: true }));
      app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));
    });
  });

  afterAll(async () => {
    await Promise.all([pair.express.close(), pair.pype.close()]);
  });

  it.each([
    "/re/42",
    "/re/42/",
    "/re/x",
    "/x/abc-12/y",
    "/opt/",
    "/opt/a",
    "/opt/b",
    "/opt/ab",
    "/dec/a%20b%2Fc",
    "/dec/%ZZ",
    "/one",
    "/two/5",
    "/three",
    "/dup",
    "/other",
    "/chain",
    "/mw/hello/rest?q=1",
    "/mw/hello",
    "/mw/hello.json",
    "/mw/hello?next=1",
    "/multi-a/x",
    "/multi-b",
    "/twice/inner/x",
    "/routed/r-7",
    "/also-routed/r-8",
    "/routed/inner-abc/deep",
    "/after-route/9",
  ])("GET %s", (path) => same(path, {}, pair));

  it.each(["/re/42", "/chain", "/one", "/routed/r-7"])("HEAD, POST, PUT and OPTIONS %s", async (path) => {
    for (const method of ["HEAD", "POST", "PUT", "OPTIONS"]) await same(path, { method }, pair);
  });

  it("mounting a router on a regular expression is reported, not silently ignored", () => {
    expect(() => new Pype().use(/^\/x/, new PypeRouter())).toThrow("Mounting a router on a regular expression is not supported");
  });
});

describe("view rendering matches Express", () => {
  const views = mkdtempSync(join(tmpdir(), "pype-views-"));
  const moreViews = mkdtempSync(join(tmpdir(), "pype-views-more-"));
  const constructed: Record<Kind, string[]> = { express: [], pype: [] };
  let pair: Pair;

  /** A tiny engine: replaces {{key}} with the option, and {{settings.x}} with a setting. */
  const tpl = (path: string, options: Record<string, any>, callback: (err: Error | null, html?: string) => void) => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const source = readFileSync(path, "utf8");
    if (source.includes("{{fail}}")) return callback(new Error("template failed"));
    callback(null, source.replace(/\{\{([\w.]+)\}\}/g, (_: string, key: string) => {
      const value = key.split(".").reduce((obj: any, part) => obj?.[part], options);
      return String(value ?? "");
    }));
  };

  beforeAll(async () => {
    mkdirSync(join(views, "users"));
    mkdirSync(join(views, "blog"));
    writeFileSync(join(views, "page.tpl"), "<h1>{{title}}</h1><p>{{who}} {{shared}}</p>");
    writeFileSync(join(views, "users", "show.tpl"), "user {{name}}");
    writeFileSync(join(views, "blog", "index.tpl"), "blog index");
    writeFileSync(join(views, "broken.tpl"), "{{fail}}");
    writeFileSync(join(views, "settings.tpl"), "env={{settings.view engine}} cache={{cache}}");
    writeFileSync(join(views, "other.html"), "html engine {{title}}");
    writeFileSync(join(moreViews, "extra.tpl"), "from the second directory");

    pair = await startPair((app, kind) => {
      class CountingView extends (kind === "express" ? require("express/lib/view") : View) {
        constructor(name: string, options: any) {
          super(name, options);
          constructed[kind].push(name);
        }
      }

      app.engine("tpl", tpl);
      app.engine(".html", (path: string, options: any, callback: any) => setTimeout(() => tpl(path, options, callback), 1));
      app.set("views", [views, moreViews]);
      app.set("view engine", "tpl");
      app.set("view", CountingView);
      app.locals.shared = "from app.locals";
      app.locals.who = "app";

      app.get("/page", (_req: any, res: any) => res.render("page", { title: "Hello" }));
      app.get("/locals", (_req: any, res: any) => {
        res.locals.who = "res.locals";
        res.render("page", { title: "Locals" });
      });
      app.get("/override", (_req: any, res: any) => {
        res.locals.who = "res.locals";
        res.render("page", { title: "Options win", who: "options" });
      });
      app.get("/nested", (_req: any, res: any) => res.render("users/show", { name: "ada" }));
      app.get("/with-ext", (_req: any, res: any) => res.render("page.tpl", { title: "Ext" }));
      app.get("/index", (_req: any, res: any) => res.render("blog"));
      app.get("/second-dir", (_req: any, res: any) => res.render("extra"));
      app.get("/html", (_req: any, res: any) => res.render("other.html", { title: "Async engine" }));
      app.get("/missing", (_req: any, res: any) => res.render("nope"));
      app.get("/broken", (_req: any, res: any) => res.render("broken"));
      app.get("/settings", (_req: any, res: any) => res.render("settings"));
      app.get("/cached", (_req: any, res: any) => res.render("users/show", { name: "cached", cache: true }));
      app.get("/callback", (_req: any, res: any) => {
        let after = "before";
        res.render("page", { title: "Callback" }, (_err: Error | null, html: string) => res.type("text").send(`${after}|${html}`));
        after = "after";
      });
      app.get("/callback-error", (_req: any, res: any) =>
        res.render("nope", (err: Error) => res.status(500).send(`callback got: ${err.message.replace(views, "VIEWS").replace(moreViews, "MORE")}`)),
      );
      app.get("/app-render", (_req: any, res: any) =>
        app.render("page", { title: "app.render" }, (err: Error | null, html: string) => (err ? res.status(500).end() : res.send(html))),
      );
      app.get("/no-engine", (_req: any, res: any) => {
        app.set("view engine", undefined);
        try {
          res.render("page");
        } finally {
          app.set("view engine", "tpl");
        }
      });
      app.get("/unknown-module", (_req: any, res: any) => res.render("page.fast-check"));
      app.get("/missing-module", (_req: any, res: any) => res.render("page.definitely-not-installed"));

      app.use((err: any, _req: any, res: any, _next: any) =>
        res.status(500).json({ error: String(err.message).replace(views, "VIEWS").replace(moreViews, "MORE").split("\n")[0], hasView: Boolean(err.view) }),
      );
    });
  });

  afterAll(async () => {
    await Promise.all([pair.express.close(), pair.pype.close()]);
    rmSync(views, { recursive: true, force: true });
    rmSync(moreViews, { recursive: true, force: true });
  });

  it.each([
    "/page",
    "/locals",
    "/override",
    "/nested",
    "/with-ext",
    "/index",
    "/second-dir",
    "/html",
    "/missing",
    "/broken",
    "/settings",
    "/callback",
    "/callback-error",
    "/app-render",
    "/no-engine",
    "/unknown-module",
    "/missing-module",
  ])("GET %s", (path) => same(path, {}, pair));

  it("HEAD of a rendered page", () => same("/page", { method: "HEAD" }, pair));

  it("caches views when asked, like Express", async () => {
    constructed.express.length = 0;
    constructed.pype.length = 0;
    for (let i = 0; i < 3; i++) await same("/cached", {}, pair);
    await same("/nested", {}, pair);
    expect(constructed.pype).toEqual(constructed.express);
    expect(constructed.pype.filter((name) => name === "users/show")).toHaveLength(2);
  });

  it("app.engine() requires a function and view cache follows env, like Express", () => {
    expect(() => new Pype().engine("x", "nope" as any)).toThrow("callback function required");
    expect(() => (express() as any).engine("x", "nope")).toThrow("callback function required");
    expect(new Pype({ env: "production" }).enabled("view cache")).toBe(true);
    expect(new Pype({ env: "development" }).enabled("view cache")).toBe(false);
    expect(new Pype().get("views")).toBe(express().get("views"));
  });
});
