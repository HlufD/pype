import { describe, it, beforeEach, expect } from "vitest";
import { RouteNode } from "../src/utils/Trie-Route";
import { HTTP_METHODS } from "../src/enums/methods.enum";

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

  it("should allow optional param followed by static segment", () => {
    expect(() =>
      router.register("/users/:id?/details", HTTP_METHODS.GET, [() => {}]),
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

  it("should allow wildcard in the middle of a path (no restriction enforced)", () => {
    expect(() =>
      router.register("/users/*/details", HTTP_METHODS.GET, [() => {}]),
    ).not.toThrow();
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
