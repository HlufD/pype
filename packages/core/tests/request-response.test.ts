import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest, IncomingHttpHeaders, Server } from "http";
import { AddressInfo } from "net";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pype } from "../src/core/server";
import { PypeRouter } from "../src/core/router";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import cookieParser from "cookie-parser";
import { json, text, urlencoded } from "../src/middlewares/body-parser";

/** A response as read by {@link send}. */
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

let port: number;
let server: Server;
let proxiedServer: Server;
let proxiedPort: number;
const fileRoot = mkdtempSync(join(tmpdir(), "pype-"));

/** Sends a raw HTTP request to the main test server, or `options.port`. */
function send(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    port?: number;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port ?? port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Creates a route handler that responds with `{ value: pick(req) }`. */
const reflect = (pick: (req: Request) => unknown) => (req: Request, res: Response) =>
  res.json({ value: pick(req) ?? null });

/**
 * Starts `app` on a free port.
 *
 * @returns The server and its port.
 */
function start(app: Pype): Promise<[Server, number]> {
  const s = app.listen(0);
  return new Promise((resolve) =>
    s.once("listening", () => resolve([s, (s.address() as AddressInfo).port])),
  );
}

beforeAll(async () => {
  writeFileSync(join(fileRoot, "hello.txt"), "hello world");
  writeFileSync(join(fileRoot, ".secret"), "secret");

  const app = new Pype();

  app.use(cookieParser());
  app.use(json());
  app.use(urlencoded());
  app.use(text());

  app.use("/mounted", (req: Request, res: Response, next) => {
    res.set("X-Mounted", `${req.baseUrl}|${req.path}|${req.originalUrl}`);
    next();
  });

  app.get("/header", reflect((req) => req.header("x-test")));
  app.get("/accepts", reflect((req) => req.accepts("json", "html")));
  app.get("/accepts-list", reflect((req) => req.accepts()));
  app.get("/charsets", reflect((req) => req.acceptsCharsets("utf-8", "iso-8859-1")));
  app.get("/encodings", reflect((req) => req.acceptsEncodings("gzip", "br")));
  app.get("/languages", reflect((req) => req.acceptsLanguages("fr", "en-US")));
  app.post("/is", reflect((req) => req.is("json", "text/*")));
  app.get("/is-no-body", reflect((req) => req.is("json")));
  app.get("/range", reflect((req) => req.range(1000)));
  app.get("/cookies", reflect((req) => req.cookies));
  app.get(
    "/connection",
    reflect((req) => ({
      protocol: req.protocol,
      secure: req.secure,
      ip: req.ip,
      ips: req.ips,
      host: req.host,
      hostname: req.hostname,
      subdomains: req.subdomains,
      xhr: req.xhr,
    })),
  );
  app.get(
    "/urls",
    reflect((req) => ({
      originalUrl: req.originalUrl,
      path: req.path,
      baseUrl: req.baseUrl,
      route: req.route,
    })),
  );
  app.get("/mounted/inner", reflect((req) => req.path));
  app.post("/body", reflect((req) => req.body));

  const router = new PypeRouter();
  router.get("/items/:id", (req: Request, res: Response) => {
    res.json({
      baseUrl: req.baseUrl,
      path: req.path,
      url: req.url,
      originalUrl: req.originalUrl,
      route: req.route,
      params: req.params,
    });
  });
  app.use("/shop", router);

  app.get("/locals", (req: Request, res: Response) => {
    res.locals.user = "ada";
    res.json({ locals: res.locals, sameApp: req.app === res.app });
  });
  app.get("/res-header", (_req: Request, res: Response) => {
    res.header("X-One", "1").header({ "X-Two": "2" }).send("ok");
  });
  app.get("/set-array", (_req: Request, res: Response) => {
    res.set("X-List", ["a", "b"]).set("Content-Type", "text/plain").send("ok");
  });
  app.get("/json-values", (_req: Request, res: Response) => {
    res.json("just a string");
  });
  app.get("/send-number", (_req: Request, res: Response) => {
    res.send(42);
  });
  app.get("/redirect", (_req: Request, res: Response) => {
    res.redirect("/target path");
  });
  app.get("/redirect-301", (_req: Request, res: Response) => {
    res.redirect(301, "/moved");
  });
  app.get("/no-content", (_req: Request, res: Response) => {
    res.status(204).send("ignored");
  });
  app.get("/cached", (_req: Request, res: Response) => {
    res.send("cached body");
  });
  app.get("/attachment", (_req: Request, res: Response) => {
    res.attachment("reports/2026 résumé.pdf").send("pdf");
  });
  app.get("/file/*", (req: Request, res: Response) => {
    res.sendFile(req.params["*"], { root: fileRoot });
  });
  app.get("/download", (_req: Request, res: Response) => {
    res.download(join(fileRoot, "hello.txt"), "greeting.txt");
  });
  app.get("/bad-status", (_req: Request, res: Response) => {
    res.status(42);
  });

  [server, port] = await start(app);

  const proxied = new Pype({ "trust proxy": true });
  proxied.get(
    "/connection",
    reflect((req) => ({
      protocol: req.protocol,
      ip: req.ip,
      ips: req.ips,
      hostname: req.hostname,
    })),
  );
  [proxiedServer, proxiedPort] = await start(proxied);
});

afterAll(() => {
  server.close();
  proxiedServer.close();
});

/** Reads the `value` field of a {@link reflect} response. */
const value = (reply: Reply) => JSON.parse(reply.body).value;

describe("Request", () => {
  it("req.header() reads headers case-insensitively", async () => {
    expect(value(await send("/header", { headers: { "X-Test": "yes" } }))).toBe("yes");
  });

  it("req.accepts() supports shorthand types and q-values", async () => {
    const html = await send("/accepts", {
      headers: { Accept: "text/html, application/json;q=0.5" },
    });
    expect(value(html)).toBe("html");

    const rejected = await send("/accepts", {
      headers: { Accept: "application/json;q=0, */*;q=0.1" },
    });
    expect(value(rejected)).toBe("html");

    const none = await send("/accepts", { headers: { Accept: "image/png" } });
    expect(value(none)).toBe(false);
  });

  it("req.accepts() with no arguments lists accepted types", async () => {
    const reply = await send("/accepts-list", {
      headers: { Accept: "text/html;q=0.5, application/json" },
    });
    expect(value(reply)).toEqual(["application/json", "text/html"]);
  });

  it("req.acceptsCharsets/Encodings/Languages negotiate", async () => {
    expect(
      value(await send("/charsets", { headers: { "Accept-Charset": "iso-8859-1" } })),
    ).toBe("iso-8859-1");
    expect(
      value(await send("/encodings", { headers: { "Accept-Encoding": "br, gzip;q=0.5" } })),
    ).toBe("br");
    expect(
      value(await send("/languages", { headers: { "Accept-Language": "en, fr;q=0.2" } })),
    ).toBe("en-US");
  });

  it("req.is() checks the request content type", async () => {
    const reply = await send("/is", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: "a,b",
    });
    expect(value(reply)).toBe("text/*");
    expect(value(await send("/is-no-body"))).toBe(null);
  });

  it("req.range() parses the Range header", async () => {
    const reply = await send("/range", { headers: { Range: "bytes=0-99,-100" } });
    expect(value(reply)).toEqual([
      { start: 0, end: 99 },
      { start: 900, end: 999 },
    ]);
  });

  it("req.cookies parses cookies, including JSON cookies", async () => {
    const reply = await send("/cookies", {
      headers: { Cookie: "a=1; prefs=j%3A%7B%22dark%22%3Atrue%7D" },
    });
    expect(value(reply)).toEqual({ a: "1", prefs: { dark: true } });
  });

  it("connection properties ignore proxy headers by default", async () => {
    const reply = await send("/connection", {
      headers: {
        Host: "api.shop.example.com:8080",
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Proto": "https",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    expect(value(reply)).toEqual({
      protocol: "http",
      secure: false,
      ip: expect.stringContaining("127.0.0.1"),
      ips: [],
      host: "api.shop.example.com:8080",
      hostname: "api.shop.example.com",
      subdomains: ["shop", "api"],
      xhr: true,
    });
  });

  it("connection properties use proxy headers when trustProxy is on", async () => {
    const reply = await send("/connection", {
      port: proxiedPort,
      headers: {
        "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "example.com",
      },
    });
    expect(value(reply)).toEqual({
      protocol: "https",
      ip: "203.0.113.9",
      ips: ["203.0.113.9", "10.0.0.1"],
      hostname: "example.com",
    });
  });

  it("sets originalUrl, path, baseUrl and route", async () => {
    expect(value(await send("/urls?x=1"))).toEqual({
      originalUrl: "/urls?x=1",
      path: "/urls",
      baseUrl: "",
      route: { path: "/urls", method: "get" },
    });
  });

  it("mounted routers see relative paths", async () => {
    const reply = await send("/shop/items/7?x=1");
    expect(JSON.parse(reply.body)).toEqual({
      baseUrl: "/shop",
      path: "/items/7",
      url: "/items/7?x=1",
      originalUrl: "/shop/items/7?x=1",
      route: { path: "/items/:id", method: "get" },
      params: { id: "7" },
    });
  });

  it("path middleware sees relative paths, restored for later handlers", async () => {
    const reply = await send("/mounted/inner?q=1");
    expect(reply.headers["x-mounted"]).toBe("/mounted|/inner|/mounted/inner?q=1");
    expect(value(reply)).toBe("/mounted/inner");
  });

  it("parses JSON, urlencoded and text bodies", async () => {
    const parsed = async (type: string, body: string) =>
      value(
        await send("/body", {
          method: "POST",
          headers: { "Content-Type": type },
          body,
        }),
      );

    expect(await parsed("application/json", '{"a":1}')).toEqual({ a: 1 });
    expect(await parsed("application/x-www-form-urlencoded", "a=1&b=2&b=3")).toEqual({
      a: "1",
      b: ["2", "3"],
    });
    expect(await parsed("text/plain", "hello")).toBe("hello");
  });

  it("rejects invalid and oversized JSON bodies", async () => {
    const invalid = await send("/body", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(invalid.status).toBe(400);

    const huge = await send("/body", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(200 * 1024) }),
    });
    expect(huge.status).toBe(413);
  });
});

describe("Response", () => {
  it("res.locals and req.app/res.app", async () => {
    const reply = await send("/locals");
    expect(JSON.parse(reply.body)).toEqual({ locals: { user: "ada" }, sameApp: true });
  });

  it("res.header() aliases res.set()", async () => {
    const reply = await send("/res-header");
    expect(reply.headers["x-one"]).toBe("1");
    expect(reply.headers["x-two"]).toBe("2");
  });

  it("res.set() accepts arrays and adds a charset to Content-Type", async () => {
    const reply = await send("/set-array");
    expect(reply.headers["x-list"]).toBe("a, b");
    expect(reply.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("res.json() sends any JSON value", async () => {
    const reply = await send("/json-values");
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(reply.body).toBe('"just a string"');
  });

  it("res.send(number) sends JSON instead of setting the status", async () => {
    const reply = await send("/send-number");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("42");
  });

  it("res.redirect() encodes the URL and supports a status", async () => {
    const found = await send("/redirect", { headers: { Accept: "text/html" } });
    expect(found.status).toBe(302);
    expect(found.headers.location).toBe("/target%20path");
    expect(found.body).toContain('<a href="/target%20path">');

    const moved = await send("/redirect-301");
    expect(moved.status).toBe(301);
    expect(moved.headers.location).toBe("/moved");
  });

  it("res.status() rejects invalid codes", async () => {
    expect((await send("/bad-status")).status).toBe(500);
  });

  it("drops the body for 204 responses", async () => {
    const reply = await send("/no-content");
    expect(reply.status).toBe(204);
    expect(reply.body).toBe("");
  });

  it("sends an ETag and answers 304 for a matching If-None-Match", async () => {
    const first = await send("/cached");
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);

    const second = await send("/cached", { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
  });

  it("answers HEAD requests using GET routes, without a body", async () => {
    const reply = await send("/cached", { method: "HEAD" });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-length"]).toBe("11");
    expect(reply.body).toBe("");
  });

  it("res.attachment() sets Content-Disposition and Content-Type", async () => {
    const reply = await send("/attachment");
    expect(reply.headers["content-type"]).toBe("application/pdf");
    expect(reply.headers["content-disposition"]).toBe(
      `attachment; filename="2026 r?sum?.pdf"; filename*=UTF-8''2026%20r%C3%A9sum%C3%A9.pdf`,
    );
  });

  it("res.sendFile() serves files with caching headers", async () => {
    const reply = await send("/file/hello.txt");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("hello world");
    expect(reply.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(reply.headers["last-modified"]).toBeDefined();
    expect(reply.headers["accept-ranges"]).toBe("bytes");
  });

  it("res.sendFile() supports byte ranges", async () => {
    const partial = await send("/file/hello.txt", { headers: { Range: "bytes=0-4" } });
    expect(partial.status).toBe(206);
    expect(partial.body).toBe("hello");
    expect(partial.headers["content-range"]).toBe("bytes 0-4/11");

    const invalid = await send("/file/hello.txt", { headers: { Range: "bytes=50-60" } });
    expect(invalid.status).toBe(416);
  });

  it("res.sendFile() blocks traversal, dotfiles and missing files", async () => {
    expect((await send("/file/..%2F..%2Fetc%2Fpasswd")).status).toBe(403);
    expect((await send("/file/.secret")).status).toBe(404);
    expect((await send("/file/missing.txt")).status).toBe(404);
  });

  it("res.download() sends the file as an attachment", async () => {
    const reply = await send("/download");
    expect(reply.body).toBe("hello world");
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="greeting.txt"');
  });
});
