import { describe, it, beforeEach, expect } from "vitest";
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

    it("normalizes wildcard paths", () => {
      router.register("/files/*", HTTP_METHODS.GET, [() => {}]);

      const result = router.match("/files//a///b/", HTTP_METHODS.GET);

      expect(result!.params["*"]).toBe("a/b");
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
