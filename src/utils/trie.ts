import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

interface DynamicChild {
  parameterName: string;
  node: TrieNode;
}

class TrieNode {
  handlers: Map<HTTP_METHODS, RouteHandler[]> = new Map();
  staticChildren: Map<string, TrieNode> = new Map();
  dynamicChild: DynamicChild | null = null;
  "*": TrieNode | null = null;
}

class Trie {
  private root = new TrieNode();

  public register(
    url: string,
    method: HTTP_METHODS,
    handlers: RouteHandler | RouteHandler[]
  ) {
    const segments = this.normalizePath(url);
    let currNode = this.root as TrieNode;
    const hasOptionalParameter = this.hasOptionalParameter(url);

    if (!this.hasOptionalParameter(url) && url.includes("?")) {
      throw new Error(`Optional parameters should be placed at the end`);
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
          segments
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

      if (currNode.dynamicChild) {
        params[currNode.dynamicChild.parameterName] = segments[i];
        currNode = currNode.dynamicChild.node;
        continue;
      }

      if (currNode["*"]) {
        console.log(segments[i]);
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
    segments: string[]
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
    currNode: TrieNode
  ): TrieNode {
    const parameterName = this.getParameterName(segment);

    if (
      currNode.dynamicChild?.parameterName &&
      parameterName != currNode.dynamicChild?.parameterName
    ) {
      throw new Error(
        `Conflicting param names :${currNode.dynamicChild?.parameterName} vs :${parameterName}`
      );
    }

    if (!currNode.dynamicChild?.parameterName) {
      currNode.dynamicChild = {
        parameterName: parameterName,
        node: new TrieNode(),
      };
    }

    return currNode.dynamicChild.node;
  }

  private registerHandlers(
    method: HTTP_METHODS,
    handlers: RouteHandler | RouteHandler[],
    currNode: TrieNode,
    segments: string[]
  ) {
    handlers = Array.isArray(handlers) ? handlers : [handlers];

    const handlerStack = currNode.handlers.get(method) || [];

    if (handlerStack.length)
      throw new Error(
        `Conflict error: /${segments.join(
          "/"
        )} route has already been registered.`
      );

    currNode.handlers.set(method, handlers);
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

const trie = new Trie();
// trie.register("//users/profile", HTTP_METHODS.GET, () => { })
// trie.register("/users/profile", HTTP_METHODS.POST, [() => { }, () => { }])
// trie.register("//users/", HTTP_METHODS.GET, () => { })
// trie.register("//users", HTTP_METHODS.GET, () => { })
// trie.register("/", HTTP_METHODS.GET, () => { })
//trie.register("/users/:id/profile/:profileId", HTTP_METHODS.GET, () => { })
// trie.register("/users/:id/profile/:userId", HTTP_METHODS.POST, () => { })

// trie.register("/users/:id", HTTP_METHODS.GET, () => { })
// trie.register("/users/:id", HTTP_METHODS.POST, () => { })

//trie.register("/users/:id", HTTP_METHODS.GET, () => { })
//trie.register("/users/:userId?", HTTP_METHODS.GET, () => { })
// trie.register("/users/:id/*", HTTP_METHODS.GET, () => {});
// trie.register("/users/some_route/*", HTTP_METHODS.GET, () => {});
trie.register("/users/:id?", HTTP_METHODS.GET, () => {});

console.dir(trie, { depth: null });

// console.log(trie.match("//users/profile", HTTP_METHODS.GET))
// // console.log(trie.match("//users", HTTP_METHODS.GET))
// // console.log(trie.match("//users", HTTP_METHODS.POST))
// console.log(trie.match("//users/12345/profile/6789", HTTP_METHODS.POST))
console.log(trie.match("/users", HTTP_METHODS.GET));

// wild card
// /user/:id/*
// user/:id?

export { Trie, TrieNode };
