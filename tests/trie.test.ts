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

describe("Parametric route registration", () => {});

describe("Wildcard route registration", () => {});

describe("Optional parameter registration", () => {});

describe("Duplicate path detection", () => {});

describe("Parameter name conflict detection", () => {});

describe("URL normalization", () => {});

describe("Complex mixed routes", () => {});

describe("Handler assignment", () => {});

describe("Advanced edge cases", () => {});
