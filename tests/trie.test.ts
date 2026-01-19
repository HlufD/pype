import { describe, it, expect, beforeEach, vi } from "vitest";
import { HTTP_METHODS } from "../src/enums/methods.enum";
import { Trie } from "../src/utils/trie";

describe("Trie Router with req/res", () => {
  let router: Trie;
  let req: any;
  let res: any;

  beforeEach(() => {
    router = new Trie();

    // Simple mocks for req/res
    req = {};
    res = { send: vi.fn() };

    // --- Register routes ---
    router.register("/users/*", HTTP_METHODS.GET, (req: any, res: any) =>
      res.send("users/*"),
    );

    router.register("/users/:id/*", HTTP_METHODS.GET, (req: any, res: any) =>
      res.send("users/:id/*"),
    );

    router.register(
      "/users/:id/profile",
      HTTP_METHODS.GET,
      (req: any, res: any) => res.send("users/:id/profile"),
    );

    router.register(
      "/users/:id/settings/*",
      HTTP_METHODS.GET,
      (req: any, res: any) => res.send("users/:id/settings/*"),
    );

    router.register(
      "/users/:id/settings/privacy",
      HTTP_METHODS.GET,
      (req: any, res: any) => res.send("users/:id/settings/privacy"),
    );

    router.register(
      "/users/:id/friends/:friendId/*",
      HTTP_METHODS.GET,
      (req: any, res: any) => res.send("users/:id/friends/:friendId/*"),
    );

    router.register(
      "/users/:id/friends/:friendId/details",
      HTTP_METHODS.GET,
      (req: any, res: any) => res.send("users/:id/friends/:friendId/details"),
    );
  });

  it("matches /users/foo to /users/*", () => {
    const result = router.match("/users/foo", HTTP_METHODS.GET);
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/*");
  });

  it("matches /users/foo/some to /users/:id/*", () => {
    const result = router.match("/users/foo/some", HTTP_METHODS.GET);
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/:id/*");
  });

  it("matches /users/foo/profile to /users/:id/profile", () => {
    const result = router.match("/users/foo/profile", HTTP_METHODS.GET);
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/:id/profile");
  });

  it("matches /users/foo/settings to /users/:id/*", () => {
    const result = router.match("/users/foo/settings", HTTP_METHODS.GET);
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/:id/*");
  });

  it("matches /users/foo/settings/privacy to /users/:id/settings/privacy", () => {
    const result = router.match(
      "/users/foo/settings/privacy",
      HTTP_METHODS.GET,
    );
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/:id/settings/privacy");
  });

  it("matches /users/foo/friends/bar to /users/:id/*", () => {
    const result = router.match("/users/foo/friends/bar", HTTP_METHODS.GET);
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/:id/*");
  });

  it("matches /users/foo/friends/bar/details to /users/:id/friends/:friendId/details", () => {
    const result = router.match(
      "/users/foo/friends/bar/details",
      HTTP_METHODS.GET,
    );
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith(
      "users/:id/friends/:friendId/details",
    );
  });

  it("matches /users/unknown/extra/path to /users/:id/*", () => {
    const result = router.match("/users/unknown/extra/path", HTTP_METHODS.GET);
    result?.handlers[0](req, res);
    expect(res.send).toHaveBeenCalledWith("users/:id/*");
  });

  it("returns null for unknown route", () => {
    const result = router.match("/not/found", HTTP_METHODS.GET);
    expect(result).toBeNull();
  });
});
