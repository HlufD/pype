import { describe, it, beforeEach, expect } from "vitest";
import fc from "fast-check";
import { RouteNode } from "../src/utils/Trie-Route";
import { HTTP_METHODS } from "../src/enums/methods.enum";

describe("RouteNode with normalization enabled", () => {
  let router: RouteNode;

  beforeEach(() => {
    router = new RouteNode({
      ignoreDuplicateSlashes: true,
      ignoreTrailingSlash: true,
    });
  });

  describe("Static route registration", () => {
    it("it should register /users successfully", () => {
      expect(() => {
        router.register("/users", HTTP_METHODS.GET, [() => {}]);
      }).not.throw();
    });

    it("it should register /products successfully", () => {
      expect(() => {
        router.register("/products", HTTP_METHODS.GET, [() => {}]);
      }).not.throw();
    });

    it("should throw duplicate path error when registering /users again", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes at: /users");
    });

    it("should normalize trailing slash and detect duplicate if ignoreTrailingSlash is true", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users/", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes at: /users");
    });

    it("should allow /users/ if ignoreTrailingSlash is false", () => {
      const router2 = new RouteNode({
        ignoreDuplicateSlashes: true,
        ignoreTrailingSlash: false,
      });
      router2.register("/users", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router2.register("/users/", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });
  });

  describe("Parametric route registration", () => {
    it("should register /users/:id", () => {
      expect(() =>
        router.register("/users/:id", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should throw parameter name conflict at same segment", () => {
      router.register("/users/:id", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("parameter name conflict");
    });

    it("should allow static child after param segment", () => {
      expect(() =>
        router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should allow multiple nested param segments", () => {
      expect(() =>
        router.register("/users/:id/details/:detailId", HTTP_METHODS.GET, [
          () => {},
        ]),
      ).not.toThrow();
    });

    it("should throw conflict on nested param name mismatch", () => {
      router.register("/users/:id/details/:detailId", HTTP_METHODS.GET, [
        () => {},
      ]);

      expect(() =>
        router.register("/users/:id/details/:anotherId", HTTP_METHODS.GET, [
          () => {},
        ]),
      ).toThrow("parameter name conflict");
    });
  });

  describe("Wildcard route registration", () => {
    it("should register /users/:id? without conflicts when node does not exist", () => {
      expect(() =>
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should throw duplicate path when registering /users/:id? twice", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("should throw parameter name conflict for optional param at same level", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId?", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes at");
    });
  });

  describe("Optional parameter registration", () => {
    it("should register /users/*", () => {
      expect(() =>
        router.register("/users/*", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should allow parametric and wildcard to coexist", () => {
      expect(() =>
        router.register("/users/:id/*", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should throw duplicate path when registering /users/* twice", () => {
      router.register("/users/*", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/*", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });
  });

  describe("Duplicate path detection", () => {
    it("should throw on duplicate static route /users", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("should throw on duplicate parametric route /users/:id", () => {
      router.register("/users/:id", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:id", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("should throw on param name conflict at same segment", () => {
      router.register("/users/:id", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("parameter name conflict");
    });

    it("should throw on duplicate optional param /users/:id?", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("should throw when wildcard route blocks later param route", () => {
      router.register("/users/:id/*", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId", HTTP_METHODS.GET, [() => {}]),
      ).toThrow();
    });
  });

  describe("Parameter name conflict detection", () => {
    it("should throw when registering /users/:userId after /users/:id", () => {
      router.register("/users/:id", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("parameter name conflict");
    });

    it("should throw when param name differs on same static path depth", () => {
      router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId/details", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("parameter name conflict");
    });

    it("should throw when wildcard route already created param node", () => {
      router.register("/users/:id/*", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:userId", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("parameter name conflict");
    });
  });

  describe("URL normalization", () => {
    it("should normalize multiple slashes (/users//details)", () => {
      router.register("/users//details", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/details", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("should normalize trailing slash when ignoreTrailingSlash is true", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("should normalize complex combination of slashes and params", () => {
      router.register("//users/:id//details/", HTTP_METHODS.GET, [() => {}]);

      expect(() =>
        router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });
  });

  describe("Complex mixed routes", () => {
    it("should register mixed routes when ordered correctly", () => {
      expect(() => {
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);
        router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]);
        router.register("/users/*", HTTP_METHODS.GET, [() => {}]);
      }).not.toThrow();
    });
  });

  describe("Advanced edge cases", () => {
    it("should register root path '/' successfully", () => {
      expect(() => {
        router.register("/", HTTP_METHODS.GET, [() => {}]);
      }).not.toThrow();
    });

    it("should throw duplicate when registering '/' again", () => {
      router.register("/", HTTP_METHODS.GET, [() => {}]);
      expect(() => {
        router.register("/", HTTP_METHODS.GET, [() => {}]);
      }).toThrow("Duplicate routes at: /");
    });
  });

  describe("Matching – static routes", () => {
    it("matches deep static path", () => {
      router.register("/users/profile/settings", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/users/profile/settings", HTTP_METHODS.GET);

      expect(result).not.toBeNull();
      expect(result!.params).toEqual({});
    });

    it("fails when static path partially matches", () => {
      router.register("/users/profile", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/users/profile/settings", HTTP_METHODS.GET);

      expect(result).toBeNull();
    });

    it("static match is case-sensitive", () => {
      router.register("/Users", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/users", HTTP_METHODS.GET)).toBeNull();
    });
  });

  describe("Matching – param extraction", () => {
    it("extracts numeric param as string", () => {
      router.register("/items/:id", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/items/123", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ id: "123" });
    });

    it("extracts dash-containing param", () => {
      router.register("/items/:slug", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/items/my-item-42", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ slug: "my-item-42" });
    });

    it("fails when param segment is missing", () => {
      router.register("/items/:id", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/items", HTTP_METHODS.GET)).toBeNull();
    });
  });

  describe("Matching – optional params", () => {
    it("matches optional param at end (missing)", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/users", HTTP_METHODS.GET);

      expect(result).not.toBeNull();
      expect(result!.params).toEqual({});
    });

    it("matches optional param at end (present)", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/users/88", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ id: "88" });
    });
  });

  describe("Matching – wildcard capture", () => {
    it("captures multiple segments", () => {
      router.register("/files/*", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/files/a/b/c/d", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ "*": "a/b/c/d" });
    });

    it("captures single segment", () => {
      router.register("/files/*", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/files/readme", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ "*": "readme" });
    });

    it("captures empty wildcard at root child", () => {
      router.register("/*", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ "*": "" });
    });
  });

  describe("Matching – wildcard fallback", () => {
    it("falls back when static path breaks later", () => {
      router.register("/users/*", HTTP_METHODS.GET, [() => {}]);
      router.register("/users/profile", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/users/unknown/path", HTTP_METHODS.GET);

      expect(result).not.toBeNull();
      expect(result!.params["*"]).toBe("unknown/path");
    });

    it("uses deepest wildcard state", () => {
      router.register("/a/*", HTTP_METHODS.GET, [() => {}]);
      router.register("/a/b/*", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/a/b/c/d", HTTP_METHODS.GET);

      expect(result!.params["*"]).toBe("c/d");
    });
  });

  describe("Matching – normalization", () => {
    it("normalizes duplicate slashes", () => {
      router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("//users//99//details", HTTP_METHODS.GET);

      expect(result!.params).toEqual({ id: "99" });
    });

    it("normalizes trailing slash", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/users/", HTTP_METHODS.GET)).not.toBeNull();
    });

    it("normalizes wildcard paths, keeping a trailing slash in the value like Express", () => {
      router.register("/files/*", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/files//a///b/", HTTP_METHODS.GET)!.params["*"]).toBe("a/b/");
      expect(router.match("/files//a///b", HTTP_METHODS.GET)!.params["*"]).toBe("a/b");
    });
  });

  describe("Matching – precedence", () => {
    it("static beats param", () => {
      const staticH = () => {};
      const paramH = () => {};

      router.register("/users/me", HTTP_METHODS.GET, [staticH]);
      router.register("/users/:id", HTTP_METHODS.GET, [paramH]);

      expect(router.match("/users/me", HTTP_METHODS.GET)!.handlers[0]).toBe(
        staticH,
      );
    });

    it("param beats wildcard", () => {
      const paramH = () => {};
      const wildH = () => {};

      router.register("/users/:id", HTTP_METHODS.GET, [paramH]);
      router.register("/users/*", HTTP_METHODS.GET, [wildH]);

      expect(router.match("/users/7", HTTP_METHODS.GET)!.handlers[0]).toBe(
        paramH,
      );
    });

    it("static beats wildcard", () => {
      const staticH = () => {};
      const wildH = () => {};

      router.register("/users/settings", HTTP_METHODS.GET, [staticH]);
      router.register("/users/*", HTTP_METHODS.GET, [wildH]);

      expect(
        router.match("/users/settings", HTTP_METHODS.GET)!.handlers[0],
      ).toBe(staticH);
    });
  });

  describe("Matching – root", () => {
    it("matches root '/'", () => {
      router.register("/", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/", HTTP_METHODS.GET)).not.toBeNull();
    });

    it("does not match root for deeper path", () => {
      router.register("/", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/users", HTTP_METHODS.GET)).toBeNull();
    });
  });

  describe("Matching – negative cases", () => {
    it("returns null when path exists but method does not", () => {
      router.register("/users", HTTP_METHODS.POST, [() => {}]);

      expect(router.match("/users", HTTP_METHODS.GET)).toBeNull();
    });

    it("returns null when path partially matches", () => {
      router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]);

      expect(router.match("/users/1", HTTP_METHODS.GET)).toBeNull();
    });

    it("returns null when only wildcard child exists but no handlers", () => {
      router.register("/users/*", HTTP_METHODS.POST, [() => {}]);

      expect(router.match("/users/anything", HTTP_METHODS.GET)).toBeNull();
    });
  });

  describe("RouteNode.validateUrl", () => {
    let router: RouteNode;

    beforeEach(() => {
      router = new RouteNode({
        ignoreDuplicateSlashes: true,
        ignoreTrailingSlash: true,
      });
    });

    it("should allow valid static URLs", () => {
      expect(() =>
        router.register("/users", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();

      expect(() =>
        router.register("/", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should allow valid optional parameter at the end", () => {
      expect(() =>
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("should allow valid wildcard at the end", () => {
      expect(() =>
        router.register("/files/*", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it.each(["/:id_2", "/:$x", "/users/:userId?", "/a/:A1/b"])(
      "should allow the param segment in %s",
      (path) => {
        expect(() => router.register(path, HTTP_METHODS.GET, [() => {}])).not.toThrow();
      },
    );

    it.each(["/:from-:to", "/b/:", "/a-:id", "/a/:id*", "/:1abc", "/a/:id.json", "/a/:?"])(
      "should throw for the unsupported param segment in %s",
      (path) => {
        expect(() => router.register(path, HTTP_METHODS.GET, [() => {}])).toThrow(
          /A parameter must take a whole segment/,
        );
      },
    );

    it("should throw if URL does not start with /", () => {
      expect(() =>
        router.register("users", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Invalid URL: users. URL must start with a '/'");
    });

    it("should throw if optional param is not at the end", () => {
      expect(() =>
        router.register("/users/:id?/details", HTTP_METHODS.GET, [() => {}]),
      ).toThrow(
        "Invalid URL: /users/:id?/details. Optional parameters can only be at the end of the URL",
      );
    });

    it("should throw if wildcard is not at the end", () => {
      expect(() =>
        router.register("/files/*/download", HTTP_METHODS.GET, [() => {}]),
      ).toThrow(
        "Invalid URL: /files/*/download. Wildcard parameters can only be at the end of the URL",
      );
    });
  });
});

describe("RouteNode with normalization disabled", () => {
  let router: RouteNode;

  beforeEach(() => {
    router = new RouteNode({
      ignoreDuplicateSlashes: false,
      ignoreTrailingSlash: false,
    });
  });

  describe("Static route registration", () => {
    it("registers /users and /products successfully", () => {
      expect(() =>
        router.register("/users", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
      expect(() =>
        router.register("/products", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("treats /users and /users/ as distinct routes", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users/", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("duplicate detection works for exact same route", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });
  });

  describe("Parametric route registration", () => {
    it("registers /users/:id successfully", () => {
      expect(() =>
        router.register("/users/:id", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("detects param name conflicts at same segment", () => {
      router.register("/users/:id", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users/:userId", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("parameter name conflict");
    });

    it("allows static child after param segment", () => {
      expect(() =>
        router.register("/users/:id/details", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("allows nested param segments", () => {
      expect(() =>
        router.register("/users/:id/details/:detailId", HTTP_METHODS.GET, [
          () => {},
        ]),
      ).not.toThrow();
    });

    it("detects nested param name mismatch", () => {
      router.register("/users/:id/details/:detailId", HTTP_METHODS.GET, [
        () => {},
      ]);
      expect(() =>
        router.register("/users/:id/details/:anotherId", HTTP_METHODS.GET, [
          () => {},
        ]),
      ).toThrow("parameter name conflict");
    });
  });

  describe("Optional parameter registration", () => {
    it("registers /users/:id? successfully", () => {
      expect(() =>
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("throws duplicate if optional param registered twice", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });
  });

  describe("Wildcard registration", () => {
    it("registers /users/*", () => {
      expect(() =>
        router.register("/users/*", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });

    it("throws duplicate when registering /users/* twice", () => {
      router.register("/users/*", HTTP_METHODS.GET, [() => {}]);
      expect(() =>
        router.register("/users/*", HTTP_METHODS.GET, [() => {}]),
      ).toThrow("Duplicate routes");
    });

    it("coexists with param segment", () => {
      expect(() =>
        router.register("/users/:id/*", HTTP_METHODS.GET, [() => {}]),
      ).not.toThrow();
    });
  });

  describe("URL validation", () => {
    it("throws if URL does not start with /", () => {
      expect(() =>
        router.register("users", HTTP_METHODS.GET, [() => {}]),
      ).toThrow();
    });

    it("throws if optional param is not at end", () => {
      expect(() =>
        router.register("/users/:id?/details", HTTP_METHODS.GET, [() => {}]),
      ).toThrow();
    });

    it("throws if wildcard is not at end", () => {
      expect(() =>
        router.register("/files/*/download", HTTP_METHODS.GET, [() => {}]),
      ).toThrow();
    });
  });

  describe("Matching – static routes", () => {
    it("matches exact static path", () => {
      router.register("/users/profile", HTTP_METHODS.GET, [() => {}]);
      const result = router.match("/users/profile", HTTP_METHODS.GET);
      expect(result).not.toBeNull();
    });

    it("does not match partial path", () => {
      router.register("/users/profile", HTTP_METHODS.GET, [() => {}]);
      expect(
        router.match("/users/profile/settings", HTTP_METHODS.GET),
      ).toBeNull();
    });

    it("treats /users and /users/ as different routes", () => {
      router.register("/users", HTTP_METHODS.GET, [() => {}]);
      router.register("/users/", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/users", HTTP_METHODS.GET)).not.toBeNull();
      expect(router.match("/users/", HTTP_METHODS.GET)).not.toBeNull();
    });
  });

  describe("Matching – param extraction", () => {
    it("extracts param correctly", () => {
      router.register("/items/:id", HTTP_METHODS.GET, [() => {}]);
      const result = router.match("/items/123", HTTP_METHODS.GET);
      expect(result!.params).toEqual({ id: "123" });
    });

    it("fails if param missing", () => {
      router.register("/items/:id", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/items", HTTP_METHODS.GET)).toBeNull();
    });
  });

  describe("Matching – optional params", () => {
    it("matches optional param missing", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/users", HTTP_METHODS.GET)!.params).toEqual({});
    });

    it("matches optional param present", () => {
      router.register("/users/:id?", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/users/42", HTTP_METHODS.GET)!.params).toEqual({
        id: "42",
      });
    });
  });

  describe("Matching – wildcard", () => {
    it("captures multiple segments", () => {
      router.register("/files/*", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/files/a/b/c", HTTP_METHODS.GET)!.params).toEqual({
        "*": "a/b/c",
      });
    });

    it("fails when segments don't match exactly", () => {
      router.register("/files/*", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/files/", HTTP_METHODS.GET)!.params["*"]).toBe("");
    });
  });

  describe("Matching – precedence", () => {
    it("static beats param", () => {
      const s = () => {};
      const p = () => {};
      router.register("/users/me", HTTP_METHODS.GET, [s]);
      router.register("/users/:id", HTTP_METHODS.GET, [p]);
      expect(router.match("/users/me", HTTP_METHODS.GET)!.handlers[0]).toBe(s);
    });

    it("param beats wildcard", () => {
      const p = () => {};
      const w = () => {};
      router.register("/users/:id", HTTP_METHODS.GET, [p]);
      router.register("/users/*", HTTP_METHODS.GET, [w]);
      expect(router.match("/users/7", HTTP_METHODS.GET)!.handlers[0]).toBe(p);
    });
  });

  describe("Matching – root", () => {
    it("matches root /", () => {
      router.register("/", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/", HTTP_METHODS.GET)).not.toBeNull();
    });

    it("does not match deeper paths", () => {
      router.register("/", HTTP_METHODS.GET, [() => {}]);
      expect(router.match("/users", HTTP_METHODS.GET)).toBeNull();
    });
  });
});

describe("Matching – param decoding", () => {
  const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
  router.register("/users/:id", HTTP_METHODS.GET, [() => {}]);
  router.register("/files/*", HTTP_METHODS.GET, [() => {}]);

  it("decodes valid escapes", () => {
    const result = router.match("/users/a%20b", HTTP_METHODS.GET);
    expect(result!.params).toEqual({ id: "a b" });
    expect(result!.error).toBeUndefined();
  });

  it.each(["/users/%ZZ", "/users/%E0%A4%A", "/users/%", "/files/a/%zz"])(
    "reports a 400 error for the malformed escape in %s",
    (path) => {
      const result = router.match(path, HTTP_METHODS.GET);
      expect(result!.params).toEqual({});
      expect(result!.error).toBeInstanceOf(URIError);
      expect(result!.error).toMatchObject({ status: 400, statusCode: 400 });
      expect(result!.error!.message).toMatch(/^Failed to decode param '/);
    },
  );
});

/** Runs of the router properties, raise with FUZZ_RUNS. */
const RUNS = Number(process.env.FUZZ_RUNS ?? 500);

/** A route segment: a static name, a param or the trailing wildcard. */
type Segment = { kind: 0; value: string } | { kind: 1 } | { kind: 2 };

/** Route path of a pattern; params are named by position so names never conflict. */
const pathOf = (pattern: Segment[]) =>
  "/" + pattern.map((s, i) => (s.kind === 0 ? s.value : s.kind === 1 ? `:p${i}` : "*")).join("/");

/**
 * The documented rule as a reference: at each segment a static match beats a
 * param, which beats the wildcard, with backtracking. That is the matching
 * pattern whose kinds are smallest position by position. A wildcard needs a
 * non-empty rest, except at the root where `/*` also matches `/`.
 */
function reference(patterns: Segment[][], segments: string[]): Segment[] | null {
  const matches = patterns.filter((pattern) => {
    for (let i = 0; i < pattern.length; i++) {
      const s = pattern[i];
      if (s.kind === 2) return i === 0 || segments.length > i;
      if (i >= segments.length) return false;
      if (s.kind === 0 && s.value !== segments[i]) return false;
    }
    return pattern.length === segments.length;
  });

  const kinds = (pattern: Segment[]) => pattern.map((s) => s.kind);
  matches.sort((a, b) => {
    const [x, y] = [kinds(a), kinds(b)];
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  return matches[0] ?? null;
}

describe("Matching – properties", () => {
  const staticSegment = fc.constantFrom("a", "b", "ab", "users");
  const segment: fc.Arbitrary<Segment> = fc.oneof(
    { weight: 3, arbitrary: staticSegment.map((value) => ({ kind: 0 as const, value })) },
    { weight: 2, arbitrary: fc.constant({ kind: 1 as const }) },
  );
  const pattern = fc
    .tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.boolean())
    .map(([segments, wildcard]) => (wildcard ? [...segments, { kind: 2 as const }] : segments));
  const patterns = fc.uniqueArray(fc.oneof(pattern, fc.constant([{ kind: 2 as const }] as Segment[])), {
    minLength: 1,
    maxLength: 25,
    selector: pathOf,
  });
  const requestPath = fc.array(fc.constantFrom("a", "b", "ab", "users", "x", "ab%20c"), { maxLength: 6 });

  it("always picks the route the precedence rules choose, with backtracking", () => {
    fc.assert(
      fc.property(patterns, fc.array(requestPath, { minLength: 1, maxLength: 20 }), (routes, paths) => {
        const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
        for (const route of routes) router.register(pathOf(route), HTTP_METHODS.GET, [() => {}], { path: pathOf(route) });

        for (const segments of paths) {
          const expected = reference(routes, segments);
          const match = router.match("/" + segments.join("/"), HTTP_METHODS.GET);
          expect(match?.route.path ?? null).toBe(expected ? pathOf(expected) : null);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("captures params and the wildcard rest from the request path", () => {
    fc.assert(
      fc.property(patterns, requestPath, (routes, segments) => {
        const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
        for (const route of routes) router.register(pathOf(route), HTTP_METHODS.GET, [() => {}], { path: pathOf(route) });

        const expected = reference(routes, segments);
        const match = router.match("/" + segments.join("/"), HTTP_METHODS.GET);
        if (!expected) {
          expect(match).toBeNull();
          return;
        }

        const params: Record<string, string> = {};
        expected.forEach((s, i) => {
          if (s.kind === 1) params[`p${i}`] = decodeURIComponent(segments[i]);
          if (s.kind === 2) params["*"] = decodeURIComponent(segments.slice(i).join("/"));
        });
        expect(match!.params).toEqual(params);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("Matching – scale", () => {
  it("matches each of 10,000 mixed routes and stays fast", () => {
    const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
    const routes: [string, string, Record<string, string>][] = [];

    for (let i = 0; i < 10_000; i++) {
      const group = `g${i % 100}`;
      if (i % 4 === 0) routes.push([`/${group}/static${i}`, `/${group}/static${i}`, {}]);
      else if (i % 4 === 1) routes.push([`/${group}/items${i}/:id`, `/${group}/items${i}/42`, { id: "42" }]);
      else if (i % 4 === 2) routes.push([`/${group}/deep${i}/:id/sub/:sub`, `/${group}/deep${i}/7/sub/x`, { id: "7", sub: "x" }]);
      else routes.push([`/${group}/files${i}/*`, `/${group}/files${i}/a/b.txt`, { "*": "a/b.txt" }]);
    }

    for (const [path] of routes) router.register(path, HTTP_METHODS.GET, [() => {}], { path });

    const started = performance.now();
    for (let round = 0; round < 5; round++) {
      for (const [path, request, params] of routes) {
        const match = router.match(request, HTTP_METHODS.GET);
        if (match?.route.path !== path) expect(match?.route.path).toBe(path);
        if (round === 0) expect(match!.params).toEqual(params);
      }
    }
    const perLookup = (performance.now() - started) / (routes.length * 5);

    expect(router.match("/g1/missing", HTTP_METHODS.GET)).toBeNull();
    // Generous bound: a linear scan of 10k routes would be orders of magnitude slower.
    expect(perLookup).toBeLessThan(0.05);
  });

  it("keeps matching deep overlapping routes without blowing up", () => {
    const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
    // Every level has a static and a param branch; only the last level has a
    // route, so a failing lookup must backtrack through all combinations.
    const depth = 12;
    for (let mask = 0; mask < 2 ** depth; mask += 97) {
      const segments = Array.from({ length: depth }, (_, i) => ((mask >> i) & 1 ? `:p${i}` : "s"));
      router.register(`/${segments.join("/")}/end`, HTTP_METHODS.GET, [() => {}]);
    }

    const started = performance.now();
    const miss = router.match(`/${Array(depth).fill("s").join("/")}/nope`, HTTP_METHODS.GET);
    expect(miss).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("Matching – Unicode and encoded paths", () => {
  const router = new RouteNode({ ignoreDuplicateSlashes: true, ignoreTrailingSlash: true });
  router.register("/café", HTTP_METHODS.GET, [() => {}], { path: "/café" });
  router.register("/caf%C3%A9-encoded", HTTP_METHODS.GET, [() => {}], { path: "/caf%C3%A9-encoded" });
  router.register("/p/:name", HTTP_METHODS.GET, [() => {}], { path: "/p/:name" });

  it("matches routes against the raw (encoded) request path, like Express", () => {
    expect(router.match("/café", HTTP_METHODS.GET)?.route.path).toBe("/café");
    expect(router.match("/caf%C3%A9-encoded", HTTP_METHODS.GET)?.route.path).toBe("/caf%C3%A9-encoded");
  });

  it.each([
    ["/p/%E6%97%A5%E6%9C%AC", "日本"],
    ["/p/caf%C3%A9", "café"],
    ["/p/a%2Fb", "a/b"],
    ["/p/%F0%9F%98%80", "😀"],
    ["/p/e%CC%81", "e\u0301"],
  ])("decodes %s to %j without normalizing Unicode", (path, value) => {
    expect(router.match(path, HTTP_METHODS.GET)?.params).toEqual({ name: value });
  });

  it("does not let an encoded slash create a new segment", () => {
    expect(router.match("/p/a%2Fb", HTTP_METHODS.GET)?.route.path).toBe("/p/:name");
    expect(router.match("/p/a/b", HTTP_METHODS.GET)).toBeNull();
  });
});
