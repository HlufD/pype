import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

interface ParameterChild {
  parameterName: string;
  node: TrieNode;
}

class TrieNode {
  handlers: Map<HTTP_METHODS, RouteHandler[]> = new Map();
  staticChildren: Map<string, TrieNode> = new Map();
  parameterChild: ParameterChild | null = null;
  "*": TrieNode | null = null;
  isRoute: boolean = false;
}

class Trie {
  private root = new TrieNode();

  public register(
    url: string,
    method: HTTP_METHODS,
    handlers: RouteHandler | RouteHandler[],
  ) {
    const segments = this.normalizePath(url);
    let currNode = this.root as TrieNode;
    const hasOptionalParameter = this.hasOptionalParameter(url);

    if (!this.hasOptionalParameter(url) && url.includes("?")) {
      throw new Error(`Optional parameters should be placed at the end`);
    }

    if (segments.includes("*") && segments[segments.length - 1] != "*") {
      throw new Error(`Wildcard parameters should be placed at the end`);
    }

    for (const segment of segments) {
      if (this.isDynamicSegment(segment)) {
        currNode = this.registerDynamicSegments(segment, currNode);
      } else if (this.hasWildCard(segment)) {
        currNode = this.registerWildCardSegment(segment, currNode);
      } else {
        currNode = this.registerStaticSegments(
          segment,
          currNode,
          handlers,
          hasOptionalParameter,
          method,
          segments,
        );
      }
    }

    this.registerHandlers(method, handlers, currNode, segments);
  }

  public match(url: string, method: HTTP_METHODS) {
    const segments = this.normalizePath(url);
    const params: Record<string, any> = {};
    let currNode = this.root;

    for (let i = 0; i < segments.length; i++) {
      if (currNode.staticChildren.has(segments[i])) {
        currNode = currNode.staticChildren.get(segments[i])!;
        continue;
      }

      if (currNode.parameterChild) {
        params[currNode.parameterChild.parameterName] = segments[i];
        currNode = currNode.parameterChild.node;
        continue;
      }

      if (currNode["*"]) {
        params["*"] = segments.slice(i).join("/");
        currNode = currNode["*"];
        break;
      }

      return null;
    }

    const handlers = currNode.handlers?.get(method);
    if (!handlers) return null;

    return { handlers, params };
  }

  private registerStaticSegments(
    segment: string,
    currNode: TrieNode,
    handlers: RouteHandler | RouteHandler[],
    hasOptionalParameter: boolean,
    method: HTTP_METHODS,
    segments: string[],
  ): TrieNode {
    if (!currNode.staticChildren.has(segment)) {
      currNode.staticChildren.set(segment, new TrieNode());
    }

    currNode = currNode.staticChildren.get(segment) as TrieNode;

    if (hasOptionalParameter) {
      this.registerHandlers(method, handlers, currNode, segments);
    }

    return currNode;
  }

  private registerDynamicSegments(
    segment: string,
    currNode: TrieNode,
  ): TrieNode {
    const parameterName = this.getParameterName(segment);

    if (
      currNode.parameterChild?.parameterName &&
      parameterName != currNode.parameterChild?.parameterName
    ) {
      throw new Error(
        `Conflicting param names :${currNode.parameterChild?.parameterName} vs :${parameterName}`,
      );
    }

    if (!currNode.parameterChild?.parameterName) {
      currNode.parameterChild = {
        parameterName: parameterName,
        node: new TrieNode(),
      };
    }

    return currNode.parameterChild.node;
  }

  private registerHandlers(
    method: HTTP_METHODS,
    handlers: RouteHandler | RouteHandler[],
    currNode: TrieNode,
    segments: string[],
  ) {
    handlers = Array.isArray(handlers) ? handlers : [handlers];

    const handlerStack = currNode.handlers.get(method) || [];

    if (handlerStack.length)
      throw new Error(
        `Conflict error: /${segments.join(
          "/",
        )} route has already been registered.`,
      );

    currNode.handlers.set(method, handlers);
    currNode.isRoute = true;
  }

  private registerWildCardSegment(segment: string, currNode: TrieNode) {
    if (!currNode["*"]) {
      currNode["*"] = new TrieNode();
    }

    currNode = currNode["*"];
    return currNode;
  }

  private normalizePath(path: string) {
    return path.split("/").filter((segment) => segment.length > 0);
  }

  private getParameterName(segment: string) {
    const parameterName = this.hasOptionalParameter(segment)
      ? segment.slice(1, segment.length - 1)
      : segment.slice(1);

    return parameterName;
  }

  private isDynamicSegment(segment: string): boolean {
    return segment.startsWith(":");
  }

  private hasOptionalParameter(segment: string) {
    return segment.endsWith("?");
  }

  private hasWildCard(segment: string) {
    return segment.endsWith("*");
  }
}

const router = new Trie();

router.register("/users/*", HTTP_METHODS.GET, () => {
  console.log("from /users/*");
});

router.register("/users/:id/*", HTTP_METHODS.GET, () => {
  console.log("from /users/:id/*");
});

router.register("/users/:id/profile", HTTP_METHODS.GET, () => {
  console.log("from /users/:id/profile");
});
router.register("/users/:id/settings/*", HTTP_METHODS.GET, () => {
  console.log("from /users/:id/settings/*");
});
router.register("/users/:id/settings/privacy", HTTP_METHODS.GET, () => {
  console.log("from /users/:id/settings/privacy");
});
router.register("/users/:id/friends/:friendId/*", HTTP_METHODS.GET, () => {
  console.log("from /users/:id/friends/:friendId/*");
});
router.register(
  "/users/:id/friends/:friendId/details",
  HTTP_METHODS.GET,
  () => {
    console.log("from /users/:id/friends/:friendId/details");
  },
);

console.dir(router, { depth: null });

const a: any = "a";
console.log("==== Test 1 ====");
router.match("/users/foo", HTTP_METHODS.GET)?.handlers[0](a, a);

console.log("==== Test 2 ====");
router.match("/users/foo/some", HTTP_METHODS.GET)?.handlers[0](a, a);

console.log("==== Test 3 ====");
router.match("/users/foo/profile", HTTP_METHODS.GET)?.handlers[0](a, a);

console.log("==== Test 4 ====");
router.match("/users/foo/settings", HTTP_METHODS.GET)?.handlers[0](a, a);

console.log("==== Test 5 ====");
router
  .match("/users/foo/settings/privacy", HTTP_METHODS.GET)
  ?.handlers[0](a, a);

console.log("==== Test 6 ====");
router.match("/users/foo/friends/bar", HTTP_METHODS.GET)?.handlers[0](a, a);

console.log("==== Test 7 ====");
router
  .match("/users/foo/friends/bar/details", HTTP_METHODS.GET)
  ?.handlers[0](a, a);

console.log("==== Test 8 ====");
router.match("/users/unknown/extra/path", HTTP_METHODS.GET)?.handlers[0](a, a);

/* Fastify
1 → from /users/*
2 → from /users/:id/*
3 → from /users/:id/profile
4 → from /users/:id/*
5 → from /users/:id/settings/privacy
6 → from /users/:id/*
7 → from /users/:id/friends/:friendId/details
8 → from /users/:id/*

*/

export { Trie, TrieNode };
