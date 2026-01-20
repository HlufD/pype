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
    let params: Record<string, any> = {};
    let currNode = this.root;

    let wildcardState: {
      node: TrieNode;
      index: number;
      params: Record<string, string>;
    } | null = null;

    let wildcardHandle: TrieNode | null = null;

    for (let i = 0; i < segments.length; i++) {
      if (currNode.staticChildren.has(segments[i])) {
        if (currNode["*"]) {
          wildcardState = {
            node: currNode["*"],
            index: i,
            params: { ...params },
          };
        }
        currNode = currNode.staticChildren.get(segments[i])!;
        continue;
      }

      if (currNode.parameterChild) {
        if (currNode["*"]) {
          wildcardState = {
            node: currNode["*"],
            index: i,
            params: { ...params },
          };
        }
        params[currNode.parameterChild.parameterName] = segments[i];
        currNode = currNode.parameterChild.node;
        continue;
      }

      if (currNode["*"]) {
        wildcardState = {
          node: currNode["*"]!,
          index: i,
          params: { ...params },
        };
        break;
      }

      return null;
    }

    let handlers = currNode.handlers?.get(method);

    if (wildcardState && !handlers) {
      currNode = wildcardState.node;
      handlers = currNode.handlers.get(method);
      params = { ...wildcardState.params };
      params["*"] = segments.slice(wildcardState.index).join("/");
    }

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

export { Trie, TrieNode };
