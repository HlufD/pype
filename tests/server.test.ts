import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressInfo } from "net";
import { Server } from "http";
import { Pype } from "../src/core/server";
import { PypeRouter } from "../src/core/router";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import { NextFunction } from "../src/types/next-function";

let server: Server;
let base: string;
const middlewareHits: string[] = [];

beforeAll(async () => {
  const app = new Pype();
  const router = new PypeRouter();

  app.use((req: Request, _res: Response, next: NextFunction) => {
    middlewareHits.push(req.path);
    next();
  });

  app.use("/scoped", (_req: Request, res: Response, next: NextFunction) => {
    res.set("X-Scoped", "yes");
    next();
  });

  router.get("/users/new", (_req: Request, res: Response) => {
    res.json({ route: "new" });
  });
  router.get("/users/:id/edit", (req: Request, res: Response) => {
    res.json({ id: req.params.id });
  });
  app.use("/api", router);

  app.get("/search", (req: Request, res: Response) => {
    res.json({ path: req.path, query: req.query });
  });
  app.get("/scoped", (_req: Request, res: Response) => {
    res.send("scoped");
  });
  app.get("/scopedish", (_req: Request, res: Response) => {
    res.send("scopedish");
  });
  app.get("/calls-next", (_req: Request, _res: Response, next) => {
    next!();
  });
  app.get("/twice", (_req: Request, res: Response, next) => {
    next!();
    next!();
  });
  app.get("/throws", () => {
    throw new Error("boom");
  });
  app.get("/rejects", async () => {
    throw new Error("async boom");
  });
  app.get("/format", (_req: Request, res: Response) => {
    res.format({ json: () => res.send({ ok: true }) });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("Pype server", () => {
  it("routes requests that have a query string", async () => {
    const res = await fetch(`${base}/search?q=node&tag=a&tag=b`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "/search",
      query: { q: "node", tag: ["a", "b"] },
    });
  });

  it("returns 404 instead of crashing when the last handler calls next()", async () => {
    const res = await fetch(`${base}/calls-next`);
    expect(res.status).toBe(404);
  });

  it("ignores a second next() call", async () => {
    const res = await fetch(`${base}/twice`);
    expect(res.status).toBe(404);
  });

  it("returns 500 for sync and async handler errors", async () => {
    expect((await fetch(`${base}/throws`)).status).toBe(500);
    expect((await fetch(`${base}/rejects`)).status).toBe(500);
  });

  it("runs global middleware for unmatched routes", async () => {
    const res = await fetch(`${base}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(middlewareHits).toContain("/does-not-exist");
  });

  it("scopes path middleware to whole segments", async () => {
    const scoped = await fetch(`${base}/scoped`);
    const lookalike = await fetch(`${base}/scopedish`);
    expect(scoped.headers.get("x-scoped")).toBe("yes");
    expect(lookalike.headers.get("x-scoped")).toBeNull();
  });

  it("backtracks from a static segment to a param route", async () => {
    const res = await fetch(`${base}/api/users/new/edit`);
    expect(await res.json()).toEqual({ id: "new" });
  });

  it("decodes route params", async () => {
    const res = await fetch(`${base}/api/users/a%20b/edit`);
    expect(await res.json()).toEqual({ id: "a b" });
  });

  it("handles a missing Accept header in res.format", async () => {
    const res = await fetch(`${base}/format`, { headers: { Accept: "" } });
    expect(res.status).toBe(200);
  });
});
