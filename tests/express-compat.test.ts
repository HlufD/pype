import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createServer,
  request as httpRequest,
  IncomingHttpHeaders,
  Server,
} from "http";
import { AddressInfo } from "net";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import compression from "compression";
import session from "express-session";
import { rateLimit } from "express-rate-limit";
import bodyParser from "body-parser";
import serveStatic from "serve-static";
import multer from "multer";
import { Pype } from "../src/core/server";
import { PypeRouter } from "../src/core/router";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import { NextFunction } from "../src/types/next-function";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

const servers: Server[] = [];
const logs: string[] = [];
const staticRoot = mkdtempSync(join(tmpdir(), "pype-static-"));

function listen(app: Pype): Promise<number> {
  const server = app.listen(0);
  servers.push(server);
  return new Promise((resolve) =>
    server.once("listening", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode!, headers: res.headers, body, text: body.toString() });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const cookieHeader = (reply: Reply) =>
  (reply.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");

let port: number;

beforeAll(async () => {
  writeFileSync(join(staticRoot, "app.css"), "body { color: red; }");

  const app = new Pype();

  app.use(morgan(":method :url :status", { stream: { write: (line: string) => logs.push(line.trim()) } }));
  app.use(helmet());
  app.use(cors({ origin: "https://example.com" }));
  app.use(cookieParser("cookie-secret"));
  app.use(bodyParser.json());
  app.use(compression({ threshold: 0 }));
  app.use(
    session({ secret: "session-secret", resave: false, saveUninitialized: false }),
  );
  app.use("/static", serveStatic(staticRoot));
  app.use("/limited", rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: "draft-7", legacyHeaders: false }));

  app.get("/hello", (_req: Request, res: Response) => {
    res.send("hello ".repeat(50));
  });

  app.get("/cookies", (req: Request, res: Response) => {
    res.cookie("plain", "1").cookie("signed", "2", { signed: true }).json({
      cookies: req.cookies,
      signedCookies: req.signedCookies,
    });
  });

  app.get("/views", (req: Request, res: Response) => {
    const s = (req as any).session;
    s.views = (s.views ?? 0) + 1;
    res.json({ views: s.views });
  });

  app.post("/echo", (req: Request, res: Response) => {
    res.json(req.body);
  });

  app.post("/upload", multer().single("file"), (req: Request, res: Response) => {
    const file = (req as any).file;
    res.json({ name: file.originalname, size: file.size, field: req.body.note });
  });

  app.get("/limited", (_req: Request, res: Response) => {
    res.send("ok");
  });

  port = await listen(app);
});

afterAll(() => {
  for (const server of servers) server.close();
});

describe("Express middleware packages", () => {
  it("morgan logs requests", async () => {
    await send(port, "/hello");
    expect(logs).toContain("GET /hello 200");
  });

  it("helmet sets security headers", async () => {
    const reply = await send(port, "/hello");
    expect(reply.headers["content-security-policy"]).toBeDefined();
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("cors handles preflight and simple requests", async () => {
    const preflight = await send(port, "/echo", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://example.com");

    const simple = await send(port, "/hello", { headers: { Origin: "https://example.com" } });
    expect(simple.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("cookie-parser parses plain and signed cookies", async () => {
    const first = await send(port, "/cookies");
    const second = await send(port, "/cookies", { headers: { Cookie: cookieHeader(first) } });
    expect(JSON.parse(second.text)).toEqual({
      cookies: { plain: "1" },
      signedCookies: { signed: "2" },
    });
  });

  it("compression gzips responses", async () => {
    const reply = await send(port, "/hello", { headers: { "Accept-Encoding": "gzip" } });
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(reply.body).toString()).toBe("hello ".repeat(50));
  });

  it("express-session keeps state between requests", async () => {
    const first = await send(port, "/views");
    const second = await send(port, "/views", { headers: { Cookie: cookieHeader(first) } });
    expect(JSON.parse(first.text)).toEqual({ views: 1 });
    expect(JSON.parse(second.text)).toEqual({ views: 2 });
  });

  it("body-parser parses JSON bodies", async () => {
    const reply = await send(port, "/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"hello":"world"}',
    });
    expect(JSON.parse(reply.text)).toEqual({ hello: "world" });
  });

  it("multer handles multipart uploads", async () => {
    const boundary = "----pype";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="note"',
      "",
      "hi",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      "Content-Type: text/plain",
      "",
      "file contents",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const reply = await send(port, "/upload", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(JSON.parse(reply.text)).toEqual({ name: "a.txt", size: 13, field: "hi" });
  });

  it("serve-static serves files under its mount path and falls through", async () => {
    const hit = await send(port, "/static/app.css");
    expect(hit.status).toBe(200);
    expect(hit.headers["content-type"]).toContain("text/css");

    const miss = await send(port, "/static/missing.css");
    expect(miss.status).toBe(404);
  });

  it("express-rate-limit limits requests", async () => {
    expect((await send(port, "/limited")).status).toBe(200);
    expect((await send(port, "/limited")).status).toBe(200);
    const blocked = await send(port, "/limited");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("Express pipeline semantics", () => {
  let p: number;
  const order: string[] = [];

  beforeAll(async () => {
    const app = new Pype();
    const router = new PypeRouter();

    router.use((req: Request, _res: Response, next: NextFunction) => {
      order.push(`router-mw ${req.baseUrl}`);
      next();
    });
    router.get("/skip", (_req: Request, _res: Response, next: NextFunction) => {
      next("router");
    });
    router.get("/item", (_req: Request, res: Response) => {
      res.send("item");
    });
    app.use("/r", router);

    app.get(
      "/multi",
      (_req: Request, res: Response, next: NextFunction) => {
        res.locals.steps = ["one"];
        next();
      },
      [
        (_req: Request, res: Response, next: NextFunction) => {
          res.locals.steps.push("two");
          next();
        },
      ],
      (_req: Request, res: Response) => {
        res.json(res.locals.steps);
      },
    );

    app.get("/next-route", (_req: Request, _res: Response, next: NextFunction) => {
      next("route");
    }, (_req: Request, res: Response) => {
      res.send("never");
    });
    app.get("/next-route", (_req: Request, res: Response) => {
      res.send("second route");
    });

    app.all("/any", (req: Request, res: Response) => {
      res.send(`any ${req.method}`);
    });

    app.get("/sync-error", () => {
      throw Object.assign(new Error("bad input"), { status: 422 });
    });
    app.get("/async-error", async () => {
      throw new Error("async failure");
    });
    app.get("/next-error", (_req: Request, _res: Response, next: NextFunction) => {
      next(new Error("passed to next"));
    });
    app.get("/unhandled", () => {
      throw Object.assign(new Error("teapot"), { status: 418 });
    });

    app.get("/settings", (req: Request, res: Response) => {
      res.json({ env: req.app.get("env"), trust: req.app.enabled("trust proxy") });
    });

    // registered after the routes, so they only run when nothing responded
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      if (req.path === "/unhandled") return next(err);
      res.status(err.status ?? 500).json({ handledBy: "error middleware", message: err.message });
    });
    app.use((req: Request, res: Response) => {
      res.status(404).json({ notFound: req.originalUrl });
    });

    p = await listen(app);
  });

  const json = async (path: string, method = "GET") =>
    JSON.parse((await send(p, path, { method })).text);

  it("runs layers in registration order, catch-all 404 last", async () => {
    expect(await json("/nope")).toEqual({ notFound: "/nope" });
    expect((await send(p, "/r/item")).text).toBe("item");
  });

  it("accepts multiple handlers and arrays per route", async () => {
    expect(await json("/multi")).toEqual(["one", "two"]);
  });

  it("next('route') skips to the next matching route", async () => {
    expect((await send(p, "/next-route")).text).toBe("second route");
  });

  it("next('router') leaves the router", async () => {
    expect(await json("/r/skip")).toEqual({ notFound: "/r/skip" });
  });

  it("router-level middleware runs with the router's baseUrl", async () => {
    order.length = 0;
    await send(p, "/r/item");
    expect(order).toEqual(["router-mw /r"]);
  });

  it("app.all matches every method", async () => {
    expect((await send(p, "/any", { method: "DELETE" })).text).toBe("any DELETE");
  });

  it("sync throws, async rejections and next(err) reach error middleware", async () => {
    expect(await json("/sync-error")).toEqual({ handledBy: "error middleware", message: "bad input" });
    expect(await json("/async-error")).toEqual({ handledBy: "error middleware", message: "async failure" });
    expect(await json("/next-error")).toEqual({ handledBy: "error middleware", message: "passed to next" });
  });

  it("errors passed on by error middleware reach the final handler", async () => {
    const reply = await send(p, "/unhandled");
    expect(reply.status).toBe(418);
    expect(JSON.parse(reply.text)).toEqual({ error: "teapot", status: 418 });
  });

  it("app.get(setting) and app.enabled() read settings", async () => {
    expect(await json("/settings")).toEqual({ env: "test", trust: false });
  });

  it("works as a plain request listener with http.createServer(app.handler)", async () => {
    const app = new Pype();
    app.get("/plain", (req: Request, res: Response) => {
      res.json({ path: req.path, accepts: req.accepts("json") });
    });

    const server = createServer(app.handler).listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));

    const reply = await send((server.address() as AddressInfo).port, "/plain");
    expect(JSON.parse(reply.text)).toEqual({ path: "/plain", accepts: "json" });
  });
});
