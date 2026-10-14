import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest, Server } from "http";
import { AddressInfo } from "net";
import { Pype } from "../src/core/server";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import { NextFunction } from "../src/types/next-function";
import { urlencoded } from "../src/middlewares/body-parser";
import { parseQuery } from "../src/utils/helpers";

let server: Server;
let port: number;

/** Sends a raw request, the path is not normalized by the client. */
function send(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

beforeAll(async () => {
  const app = new Pype();

  app.use("/admin", (_req: Request, res: Response) => {
    res.status(401).send("auth required");
  });
  app.get("/admin/secret", (_req: Request, res: Response) => {
    res.send("secret");
  });

  app.use("/inspect", (req: Request, res: Response, next: NextFunction) => {
    res.set("X-Mounted", `${req.baseUrl}|${req.path}|${req.url}`);
    next();
  });
  app.get("/inspect/:id", (req: Request, res: Response) => {
    res.json({ path: req.path, url: req.url, originalUrl: req.originalUrl, params: req.params });
  });

  app.get("/query", (req: Request, res: Response) => {
    res.json({
      query: req.query,
      prototype: Object.getPrototypeOf(req.query) === null ? "null" : "object",
    });
  });

  app.post("/form", urlencoded(), (req: Request, res: Response) => {
    res.json({ body: req.body, prototype: Object.getPrototypeOf(req.body) === null ? "null" : "object" });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

describe("path normalization", () => {
  it.each(["/admin/secret", "//admin/secret", "/admin//secret", "///admin///secret/"])(
    "path middleware can't be bypassed with %s",
    async (path) => {
      const reply = await send(path);
      expect(reply.status).toBe(401);
      expect(reply.body).not.toContain("secret");
    },
  );

  it("gives middleware and routes consistent paths for duplicate slashes", async () => {
    const reply = await send("//inspect//42?x=1");
    expect(JSON.parse(reply.body)).toEqual({
      path: "/inspect/42",
      url: "/inspect/42?x=1",
      originalUrl: "//inspect//42?x=1",
      params: { id: "42" },
    });
  });
});

describe("query and form parsing", () => {
  it("parseQuery returns objects without a prototype", () => {
    const query = parseQuery("__proto__=a&__proto__=b&constructor=c&toString=d&toString=e");
    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(Object.entries(query)).toEqual([
      ["__proto__", ["a", "b"]],
      ["constructor", "c"],
      ["toString", ["d", "e"]],
    ]);
  });

  it("can't change the prototype of req.query", async () => {
    const reply = await send("/query?__proto__=a&__proto__=b&toString=x");
    const body = JSON.parse(reply.body);
    expect(body.prototype).toBe("null");
    expect(Object.entries(body.query)).toEqual([
      ["__proto__", ["a", "b"]],
      ["toString", "x"],
    ]);
  });

  it("can't change the prototype of urlencoded bodies", async () => {
    const reply = await send("/form", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "__proto__=x&__proto__=y&constructor=z",
    });
    expect(JSON.parse(reply.body).prototype).toBe("null");
    expect(({} as any).constructor).toBe(Object);
  });
});
