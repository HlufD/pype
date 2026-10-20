import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { Pype } from "../src/core/server";
import { PypeRouter } from "../src/core/router";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import { NextFunction } from "../src/types/next-function";
import bodyParser from "body-parser";
import { json, raw, text, urlencoded } from "../src/middlewares/body-parser";
import { start, TestServer } from "./support/http";

describe("request API", () => {
  let api: TestServer;

  beforeAll(async () => {
    const app = new Pype({ "subdomain offset": 1 });
    const reflect = (pick: (req: Request) => unknown) => (req: Request, res: Response) =>
      res.json({ value: pick(req) ?? null });

    app.get("/referrer", reflect((req) => req.get("Referrer")));
    app.get("/accepts", reflect((req) => req.accepts(["json", "html"])));
    app.get("/charsets", reflect((req) => req.acceptsCharsets()));
    app.get("/encodings", reflect((req) => req.acceptsEncodings("gzip", "identity")));
    app.get("/encodings-list", reflect((req) => req.acceptsEncodings()));
    app.get("/languages", reflect((req) => req.acceptsLanguages("fr")));
    app.all("/is", reflect((req) => req.is()));
    app.post("/is-json", reflect((req) => req.is("+json")));
    app.get("/host", reflect((req) => ({ hostname: req.hostname, subdomains: req.subdomains })));
    app.get("/range", reflect((req) => ({ none: req.range(10) ?? "none", bad: "x" })));
    app.get("/stale", reflect((req) => ({ fresh: req.fresh, stale: req.stale })));
    app.post("/stale", reflect((req) => req.fresh));

    api = await start(app);
  });

  afterAll(async () => {
    await api.close();
  });

  const value = async (path: string, options?: Parameters<TestServer["send"]>[1]) =>
    (await api.json(path, options)).value;

  it("treats Referer and Referrer as the same header", async () => {
    expect(await value("/referrer", { headers: { Referer: "https://a.example" } })).toBe(
      "https://a.example",
    );
  });

  it("accepts takes arrays and returns the first offer without an Accept header", async () => {
    expect(await value("/accepts")).toBe("json");
  });

  it("acceptsCharsets without arguments lists accepted charsets", async () => {
    expect(await value("/charsets")).toEqual(["*"]);
    expect(await value("/charsets", { headers: { "Accept-Charset": "utf-8, latin1;q=0" } })).toEqual([
      "utf-8",
    ]);
  });

  it("identity is acceptable unless refused", async () => {
    expect(await value("/encodings", { headers: { "Accept-Encoding": "br" } })).toBe("identity");
    expect(
      await value("/encodings", { headers: { "Accept-Encoding": "br, identity;q=0" } }),
    ).toBe(false);
    expect(await value("/encodings-list")).toEqual(["identity"]);
  });

  it("acceptsLanguages returns false when nothing matches", async () => {
    expect(await value("/languages", { headers: { "Accept-Language": "de" } })).toBe(false);
  });

  it("is() returns the content type, null without a body, false without Content-Type", async () => {
    const body = "{}";
    expect(
      await value("/is", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json; charset=utf-8", "Content-Length": "2" },
        body,
      }),
    ).toBe("application/vnd.api+json");
    expect(
      await value("/is-json", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json", "Content-Length": "2" },
        body,
      }),
    ).toBe("application/vnd.api+json");
    // Like type-is: no Content-Length or Transfer-Encoding means no body,
    // while Content-Length: 0 (what Node's client sends for an empty POST) is one.
    expect(await value("/is", { method: "DELETE" })).toBe(null);
    expect(await value("/is", { method: "POST" })).toBe(false);
    expect(
      await value("/is", { method: "POST", headers: { "Transfer-Encoding": "chunked" }, body }),
    ).toBe(false);
  });

  it("hostname handles IPv6 literals and IPs have no subdomains", async () => {
    expect(await value("/host", { headers: { Host: "[::1]:3000" } })).toEqual({
      hostname: "[::1]",
      subdomains: [],
    });
    expect(await value("/host", { headers: { Host: "127.0.0.1" } })).toEqual({
      hostname: "127.0.0.1",
      subdomains: [],
    });
    expect(await value("/host", { headers: { Host: "a.b.example.com" } })).toEqual({
      hostname: "a.b.example.com",
      subdomains: ["example", "b", "a"],
    });
  });

  it("range returns undefined without a Range header", async () => {
    expect(await value("/range")).toEqual({ none: "none", bad: "x" });
  });

  it("fresh is false for non-GET requests and stale mirrors it", async () => {
    expect(await value("/stale")).toEqual({ fresh: false, stale: true });
    expect(await value("/stale", { method: "POST", headers: { "If-None-Match": "*" } })).toBe(false);
  });
});

describe("routing API", () => {
  let api: TestServer;

  beforeAll(async () => {
    const app = new Pype();
    const router = new PypeRouter();

    router
      .route("/items")
      .all((req: Request, _res: Response, next: NextFunction) => {
        req.app.locals.lastMethod = req.method;
        next();
      })
      .get((_req: Request, res: Response) => res.send("get"))
      .post((_req: Request, res: Response) => res.send("post"))
      .put((_req: Request, res: Response) => res.send("put"))
      .patch((_req: Request, res: Response) => res.send("patch"))
      .delete((_req: Request, res: Response) => res.send("delete"))
      .options((_req: Request, res: Response) => res.send("options"))
      .head((_req: Request, res: Response) => res.set("X-Head", "1").end());

    router.head("/only-head", (_req: Request, res: Response) => res.set("X-Head", "2").end());
    router.options("/only-options", (_req: Request, res: Response) => res.send("opts"));

    app.use("/r", router);
    app.put("/app/put", (_req: Request, res: Response) => res.send("put"));
    app.patch("/app/patch", (_req: Request, res: Response) => res.send("patch"));
    app.delete("/app/delete", (_req: Request, res: Response) => res.send("delete"));
    app.head("/app/head", (_req: Request, res: Response) => res.set("X-Head", "3").end());
    app.options("/app/options", (_req: Request, res: Response) => res.send("options"));
    app
      .route("/app/chain")
      .get((_req: Request, res: Response) => res.send("chain get"))
      .post((_req: Request, res: Response) => res.send("chain post"));

    app.enable("flag").disable("other");
    app.get("/settings", (req: Request, res: Response) => {
      res.json({ flag: req.app.enabled("flag"), other: req.app.disabled("other") });
    });

    api = await start(app);
  });

  afterAll(async () => {
    await api.close();
  });

  it("route() chains every method", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await api.send("/r/items", { method })).text).toBe(method.toLowerCase());
    }
    expect((await api.send("/r/items", { method: "HEAD" })).headers["x-head"]).toBe("1");
  });

  it("explicit HEAD and OPTIONS routes", async () => {
    expect((await api.send("/r/only-head", { method: "HEAD" })).headers["x-head"]).toBe("2");
    expect((await api.send("/r/only-options", { method: "OPTIONS" })).text).toBe("opts");
    expect((await api.send("/app/head", { method: "HEAD" })).headers["x-head"]).toBe("3");
  });

  it("app verbs and app.route()", async () => {
    expect((await api.send("/app/put", { method: "PUT" })).text).toBe("put");
    expect((await api.send("/app/patch", { method: "PATCH" })).text).toBe("patch");
    expect((await api.send("/app/delete", { method: "DELETE" })).text).toBe("delete");
    expect((await api.send("/app/options", { method: "OPTIONS" })).text).toBe("options");
    expect((await api.send("/app/chain")).text).toBe("chain get");
    expect((await api.send("/app/chain", { method: "POST" })).text).toBe("chain post");
  });

  it("enable, disable, enabled and disabled", async () => {
    expect(await api.json("/settings")).toEqual({ flag: true, other: true });
  });

  it("rejects invalid registrations", () => {
    const router = new PypeRouter();
    expect(() => router.use()).toThrow(TypeError);
    expect(() => router.use("/x", 42 as unknown as () => void)).toThrow(TypeError);
    expect(() => router.get("/x")).toThrow(TypeError);
    expect(() => router.get("/x", "nope" as unknown as () => void)).toThrow(TypeError);
  });
});

describe("error handling", () => {
  it("responds 500 when routes conflict at request time", async () => {
    const app = new Pype();
    app.get("/a/:id", (_req: Request, res: Response) => res.send("a"));
    app.get("/a/:other/x", (_req: Request, res: Response) => res.send("b"));

    const handler = app.handler;
    const server = createServer(handler).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const reply = await fetch(`http://127.0.0.1:${port}/a/1`);
    server.close();

    expect(reply.status).toBe(500);
  });

  it("listen binds to a hostname", async () => {
    const app = new Pype();
    app.get("/", (_req: Request, res: Response) => res.send("ok"));

    const server = await new Promise<ReturnType<Pype["listen"]>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    const reply = await fetch(`http://127.0.0.1:${address.port}/`);
    server.close();

    expect(address.address).toBe("127.0.0.1");
    expect(await reply.text()).toBe("ok");
  });

  it("listen throws on conflicting routes", () => {
    const app = new Pype();
    app.get("/a/:id", (_req: Request, res: Response) => res.send("a"));
    app.get("/a/:other/x", (_req: Request, res: Response) => res.send("b"));
    expect(() => app.listen(0)).toThrow("parameter name conflict");
  });

  it("logs errors outside the test env and applies error headers", async () => {
    const app = new Pype({ env: "production" });
    app.get("/fail", () => {
      throw Object.assign(new Error("hidden detail"), { status: 503, headers: { "Retry-After": "10" } });
    });

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = await start(app);
    const reply = await api.send("/fail");
    await api.close();
    const logged = log.mock.calls.length;
    log.mockRestore();

    expect(reply.status).toBe(503);
    expect(reply.headers["retry-after"]).toBe("10");
    expect(JSON.parse(reply.text)).toEqual({ error: "Service Unavailable", status: 503 });
    expect(logged).toBe(1);
  });

  it("destroys the socket when an error happens after headers were sent", async () => {
    const app = new Pype();
    app.get("/partial", (_req: Request, res: Response) => {
      res.write("partial");
      throw new Error("too late");
    });

    const api = await start(app);
    const error = await fetch(`http://127.0.0.1:${api.port}/partial`)
      .then((reply) => reply.text())
      .then(() => null, (e) => e);
    await api.close();

    expect(error).not.toBeNull();
  });

  it("does not send a 404 after a handler already responded", async () => {
    const app = new Pype();
    app.get("/done", (_req: Request, res: Response, next: NextFunction) => {
      res.send("done");
      next();
    });

    const api = await start(app);
    const reply = await api.send("/done");
    await api.close();

    expect(reply.status).toBe(200);
    expect(reply.text).toBe("done");
  });

  it("upgrades plain IncomingMessage and ServerResponse objects", async () => {
    const app = new Pype();
    app.get("/", (req: Request, res: Response) => res.json({ isPype: req instanceof Request && res instanceof Response }));

    const server = createServer((req: IncomingMessage, res: ServerResponse) => app.handler(req, res)).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const reply = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    server.close();

    expect(await reply.json()).toEqual({ isPype: true });
  });
});

describe("body parsers", () => {
  let api: TestServer;

  beforeAll(async () => {
    const app = new Pype();
    app.post("/json", json({ limit: 20 }), (req: Request, res: Response) => res.json({ body: req.body }));
    app.post("/json-loose", json({ strict: false, limit: "1kb" }), (req: Request, res: Response) =>
      res.json({ body: req.body }),
    );
    app.post("/raw", raw({ limit: "1mb" }), (req: Request, res: Response) =>
      res.json({ length: (req.body as Buffer).length }),
    );
    app.post(
      "/custom-type",
      text({ type: (req: Request) => req.headers["x-parse"] === "yes" }),
      (req: Request, res: Response) => res.json({ body: req.body ?? null }),
    );
    app.post("/twice", json(), json(), (req: Request, res: Response) => res.json({ body: req.body }));
    app.post("/form", urlencoded({ type: ["urlencoded", "text/plain"] }), (req: Request, res: Response) =>
      res.json({ body: { ...req.body } }),
    );

    api = await start(app);
  });

  afterAll(async () => {
    await api.close();
  });

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    api.send(path, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

  it("treats empty JSON bodies, chunked or with Content-Length: 0, as an empty object like body-parser", async () => {
    expect(JSON.parse((await post("/json", "", { "Transfer-Encoding": "chunked" })).text)).toEqual({ body: {} });
    expect(JSON.parse((await post("/json", "", { "Content-Length": "0" })).text)).toEqual({ body: {} });
  });

  it("rejects whitespace-only JSON bodies like body-parser", async () => {
    for (const path of ["/json", "/json-loose"]) {
      for (const body of ["  ", "\n", " \t\r\n"]) {
        const reply = await post(path, body);
        expect(reply.status).toBe(400);
        expect(JSON.parse(reply.text).error).toBeTruthy();
      }
    }
  });

  it("rejects primitives in strict mode and accepts them otherwise", async () => {
    expect((await post("/json", '"text"')).status).toBe(400);
    expect(JSON.parse((await post("/json-loose", '"text"')).text)).toEqual({ body: "text" });
  });

  it("rejects bodies over the limit while streaming", async () => {
    const reply = await api.send("/json", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      body: JSON.stringify({ data: "x".repeat(100) }),
    });
    expect(reply.status).toBe(413);
  });

  it("throws when created with a NaN limit, which would disable it, like body-parser", () => {
    for (const parser of [json, urlencoded, text, raw]) {
      expect(() => parser({ limit: NaN })).toThrow(TypeError);
      expect(() => parser({ limit: Infinity })).not.toThrow();
    }
  });

  it("stops inflating a compressed body once it passes the limit", async () => {
    const { gzipSync } = await import("zlib");
    // 50 MB of zeros compress to about 50 KB: a decompression bomb for a 20 byte limit.
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024));
    const started = performance.now();
    const reply = await post("/json", bomb as any, { "Content-Encoding": "gzip" });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.text).error).toBe("request entity too large");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads raw bodies", async () => {
    const reply = await api.send("/raw", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(1000),
    });
    expect(JSON.parse(reply.text)).toEqual({ length: 1000 });
  });

  it("supports a type predicate and a list of types", async () => {
    const skipped = await api.send("/custom-type", { method: "POST", body: "hi" });
    const parsed = await api.send("/custom-type", { method: "POST", body: "hi", headers: { "X-Parse": "yes" } });
    expect(JSON.parse(skipped.text)).toEqual({ body: null });
    expect(JSON.parse(parsed.text)).toEqual({ body: "hi" });

    const form = await api.send("/form", { method: "POST", body: "a=1", headers: { "Content-Type": "text/plain" } });
    expect(JSON.parse(form.text)).toEqual({ body: { a: "1" } });
  });

  it("parses a body only once", async () => {
    expect(JSON.parse((await post("/twice", '{"a":1}')).text)).toEqual({ body: { a: 1 } });
  });

  it("skips bodies already read by the body-parser package", async () => {
    const app = new Pype();
    app.post("/both", bodyParser.json(), json(), (req: Request, res: Response) => res.json({ body: req.body }));

    const server = await start(app);
    const reply = await Promise.race([
      server.send("/both", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}',
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    await server.close();

    expect(reply && JSON.parse(reply.text)).toEqual({ body: { a: 1 } });
  });

  it("rejects invalid limits", () => {
    expect(() => json({ limit: "lots" })).toThrow(TypeError);
  });
});
