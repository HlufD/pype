import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { request as httpRequest, Server, validateHeaderValue } from "http";
import { AddressInfo } from "net";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pype } from "../src/core/server";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import { RouteNode } from "../src/utils/Trie-Route";
import { parseQs } from "../src/utils/qs";
import { HTTP_METHODS } from "../src/enums/methods.enum";
import {
  contentDisposition,
  encodeUrl,
  preferredMediaTypes,
  parseQuery,
  parseRange,
  serializeCookie,
} from "../src/utils/helpers";

/** Runs of fast-check per property, raise locally for deeper fuzzing. */
const RUNS = Number(process.env.FUZZ_RUNS ?? 500);

/** Throws when `value` can't be used as an HTTP header value. */
const assertValidHeader = (value: string) => validateHeaderValue("X-Test", value);

describe("parsers never throw and keep their invariants", () => {
  it("parseQuery", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (search) => {
        const query = parseQuery(search);
        expect(Object.getPrototypeOf(query)).toBeNull();
        for (const value of Object.values(query)) {
          const values = Array.isArray(value) ? value : [value];
          for (const v of values) expect(typeof v).toBe("string");
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("parseRange", () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.string(), (size, header) => {
        const result = parseRange(size, `bytes=${header}`, { combine: true });
        if (result === -1 || result === -2) return;
        for (const range of result) {
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.start).toBeLessThanOrEqual(range.end);
          expect(range.end).toBeLessThan(size);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("preferredMediaTypes only returns offered values", () => {
    const offers = ["application/json", "text/html", "text/plain", "image/png"];
    fc.assert(
      fc.property(fc.string(), (header) => {
        for (const offer of preferredMediaTypes(header, offers)) {
          expect(offers).toContain(offer);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("generated headers are always valid", () => {
  it("contentDisposition", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (filename) => {
        assertValidHeader(contentDisposition(filename));
      }),
      { numRuns: RUNS },
    );
  });

  it("encodeUrl", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (url) => {
        let encoded: string;
        try {
          encoded = encodeUrl(url);
        } catch (error) {
          expect(error).toBeInstanceOf(URIError);
          return;
        }
        assertValidHeader(encoded);
      }),
      { numRuns: RUNS },
    );
  });

  it("serializeCookie rejects or produces exactly one cookie", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }),
        fc.string({ unit: "binary" }),
        fc.option(fc.string({ unit: "binary" }), { nil: undefined }),
        fc.option(fc.string({ unit: "binary" }), { nil: undefined }),
        (name, value, domain, path) => {
          let cookie: string;
          try {
            cookie = serializeCookie(name, value, { domain, path });
          } catch (error) {
            expect(error).toBeInstanceOf(TypeError);
            return;
          }
          assertValidHeader(cookie);
          expect(cookie.startsWith(`${name}=`)).toBe(true);
          expect(cookie.split(";")[0]).toBe(`${name}=${encodeURIComponent(value)}`);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("router", () => {
  /** A path segment that is safe to use as static text. */
  const segment = fc.stringMatching(/^[a-z0-9-]{1,8}$/);

  it("every route matches its own concrete paths", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.array(segment, { minLength: 1, maxLength: 5 }), {
          minLength: 1,
          maxLength: 20,
          selector: (segments) => segments.join("/"),
        }),
        fc.array(fc.string({ unit: "binary" }), { minLength: 5, maxLength: 5 }),
        (routes, values) => {
          const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
          const handlers = new Map<string, () => void>();

          for (const segments of routes) {
            const path = `/${segments.join("/")}`;
            const handler = () => {};
            handlers.set(path, handler);
            router.register(path, HTTP_METHODS.GET, [handler]);
          }

          for (const [path, handler] of handlers) {
            const match = router.match(path, HTTP_METHODS.GET);
            expect(match?.handlers[0]).toBe(handler);
          }

          const paramRouter = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
          paramRouter.register("/a/:one/b/:two/*", HTTP_METHODS.GET, [() => {}]);
          const [one, two, ...rest] = values.map((v) => encodeURIComponent(v) || "x");
          const match = paramRouter.match(`/a/${one}/b/${two}/${rest.join("/")}`, HTTP_METHODS.GET);
          expect(match?.params.one).toBe(decodeURIComponent(one));
          expect(match?.params.two).toBe(decodeURIComponent(two));
        },
      ),
      { numRuns: RUNS / 5 },
    );
  });

  it("match never throws on arbitrary paths", () => {
    const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
    router.register("/", HTTP_METHODS.GET, [() => {}]);
    router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);
    router.register("/files/*", HTTP_METHODS.GET, [() => {}]);
    router.register("/a/:b/c/:d", HTTP_METHODS.GET, [() => {}]);

    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (path) => {
        router.match(`/${path}`, HTTP_METHODS.GET);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("HTTP", () => {
  let server: Server;
  let port: number;
  const root = mkdtempSync(join(tmpdir(), "pype-fuzz-"));
  const publicDir = join(root, "public");
  const SECRET = "top-secret-outside-root";

  /** Sends a raw request, returning `null` when Node refuses the path. */
  function send(path: string): Promise<{ status: number; body: string } | null> {
    return new Promise((resolve) => {
      let req;
      try {
        req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        });
      } catch {
        return resolve(null);
      }
      req.on("error", () => resolve(null));
      req.end();
    });
  }

  beforeAll(async () => {
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "hello.txt"), "hello");
    writeFileSync(join(root, "secret.txt"), SECRET);

    const app = new Pype();
    app.use("/admin", (_req: Request, res: Response) => {
      res.status(401).send("auth required");
    });
    app.get("/admin/*", (_req: Request, res: Response) => {
      res.send(SECRET);
    });
    app.get("/files/*", (req: Request, res: Response) => {
      res.sendFile(req.params["*"], { root: publicDir });
    });
    app.get("/users/:id", (req: Request, res: Response) => {
      res.json(req.params);
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  /** Path pieces that tend to break routers and file servers. */
  const piece = fc.constantFrom(
    "", "/", "//", ".", "..", "%2e%2e", "%2E%2E", "%2f", "%2F", "%5c", "\\",
    "%00", "admin", "files", "users", "secret.txt", "hello.txt", "public",
    "%", "%zz", "?", "?x=1", "#", ";", "%20", "é", "%C3%A9", "~",
  );

  it("never crashes, leaks files outside the root or bypasses /admin (Node's parser may answer 400)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { maxLength: 8 }), async (pieces) => {
        const path = `/${pieces.join("")}`;
        const reply = await send(path);
        if (!reply) return;

        expect(reply.status).toBeLessThan(500);
        expect(reply.body).not.toContain(SECRET);

        const normalized = path.split("?")[0].replace(/\/{2,}/g, "/");
        if (normalized === "/admin" || normalized.startsWith("/admin/")) {
          expect([400, 401]).toContain(reply.status);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("the qs port", () => {
  // The real package, only used by the tests.
  const qs = require("qs") as typeof import("qs");
  const piece = fc.constantFrom(
    "a", "b", "0", "1", "5", "25", "[", "]", "[]", "[0]", "[1]", "[25]", "[a]", "=", "&", "%5B", "%5D", "%",
    "%E9", "%C3%A9", "+", "x", "__proto__", "constructor", ".", "utf8=%E2%9C%93", "utf8=%26%2310003%3B", "&#233;",
  );
  const options = fc.record({
    arrayLimit: fc.constantFrom(0, 1, 2, 5, 20),
    depth: fc.constantFrom(0, 1, 2, 5),
    parameterLimit: fc.constantFrom(1, 3, 1000),
    strictDepth: fc.boolean(),
    charset: fc.constantFrom("utf-8" as const, "iso-8859-1" as const),
    charsetSentinel: fc.boolean(),
    interpretNumericEntities: fc.boolean(),
  });

  const outcome = (parse: () => unknown) => {
    try {
      return { value: JSON.stringify(parse()) };
    } catch (error) {
      return { error: (error as Error).constructor.name + ": " + (error as Error).message };
    }
  };

  it("parses exactly like qs.parse with allowPrototypes and plainObjects", () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 24 }).map((p) => p.join("")), options, (input, opts) => {
        expect(outcome(() => parseQs(input, opts))).toEqual(
          outcome(() => qs.parse(input, { ...opts, allowPrototypes: true, plainObjects: true })),
        );
      }),
      { numRuns: RUNS * 4 },
    );
  });

  it("creates objects without a prototype and never pollutes Object.prototype", () => {
    const parsed = parseQs("__proto__[polluted]=1&a[__proto__][polluted]=1&constructor[prototype][polluted]=1", { depth: 5 });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed.constructor)).toBeNull();
  });
});
