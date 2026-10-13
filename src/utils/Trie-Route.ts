import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

const enum SEGMENT_TYPE {
  "static" = "static",
  "parametric" = "parametric",
  "wildcard" = "wildcard",
  "optional" = "optional",
}

interface Options {
  ignoreDuplicateSlashes?: boolean;
  ignoreTrailingSlash?: boolean;
}

class Node {
  public handlers: Map<HTTP_METHODS, RouteHandler[]>;
  public staticNodes: Map<string, Node>;
  public wildCardNode: Node | null;
  public parametricNode: Node | null;
  public parameter?: string | null;

  constructor() {
    this.handlers = new Map();
    this.staticNodes = new Map();
    this.parametricNode = null;
    this.wildCardNode = null;
    this.parameter = null;
  }
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

class RouteNode {
  private root = new Node();
  public config: Options = {
    ignoreDuplicateSlashes: false,
    ignoreTrailingSlash: false,
  };

  constructor(config: Options) {
    this.config = config;
  }

  register(url: string, method: HTTP_METHODS, handlers: RouteHandler[]) {
    this.validateUrl(url);
    let currentNode = this.root;
    const segments = this.normalizeUrl(url);

    for (const segment of segments) {
      switch (this.identifySegmentType(segment)) {
        case SEGMENT_TYPE.static:
          currentNode = this.registerStaticNode(segment, currentNode);
          break;

        case SEGMENT_TYPE.parametric:
          currentNode = this.registerParametricNode(segment, currentNode);
          break;

        case SEGMENT_TYPE.wildcard:
          currentNode = this.registerWildcardSegment(segment, currentNode);
          break;

        case SEGMENT_TYPE.optional:
          currentNode = this.registerOptionalSegment(
            segment,
            currentNode,
            method,
            handlers,
            segments,
          );
          break;

        default:
          break;
      }
    }

    this.registerHandlers(method, handlers, currentNode, segments);
  }

  match(url: string, method: HTTP_METHODS) {
    const segments = this.normalizeUrl(url);

    if (segments.length === 0) {
      const handlers = this.root.handlers.get(method);
      if (handlers) return { handlers, params: {} };

      const wildcardHandlers = this.root.wildCardNode?.handlers.get(method);
      if (wildcardHandlers)
        return { handlers: wildcardHandlers, params: { "*": "" } };

      return null;
    }

    return this.matchNode(this.root, segments, 0, method, {});
  }

  private matchNode(
    node: Node,
    segments: string[],
    index: number,
    method: HTTP_METHODS,
    params: Record<string, string>,
  ): { handlers: RouteHandler[]; params: Record<string, string> } | null {
    if (index === segments.length) {
      const handlers = node.handlers.get(method);
      return handlers ? { handlers, params } : null;
    }

    const segment = segments[index];

    const staticChild = node.staticNodes.get(segment);
    if (staticChild) {
      const result = this.matchNode(
        staticChild,
        segments,
        index + 1,
        method,
        params,
      );
      if (result) return result;
    }

    const parametricChild = node.parametricNode;
    if (parametricChild) {
      const result = this.matchNode(
        parametricChild,
        segments,
        index + 1,
        method,
        { ...params, [parametricChild.parameter!]: safeDecode(segment) },
      );
      if (result) return result;
    }

    const wildcardHandlers = node.wildCardNode?.handlers.get(method);
    if (wildcardHandlers) {
      return {
        handlers: wildcardHandlers,
        params: {
          ...params,
          "*": safeDecode(segments.slice(index).join("/")),
        },
      };
    }

    return null;
  }

  private registerStaticNode(segment: string, currentNode: Node): Node {
    if (!currentNode.staticNodes.has(segment)) {
      currentNode.staticNodes.set(segment, new Node());
    }

    currentNode = currentNode.staticNodes.get(segment)!;
    return currentNode;
  }

  private registerParametricNode(segment: string, currentNode: Node): Node {
    const parameterName = this.getParamName(segment);
    const saveParameterName = currentNode.parametricNode?.parameter;

    if (saveParameterName && saveParameterName !== parameterName)
      throw new Error(
        `parameter name conflict: ${parameterName} vs ${currentNode.parametricNode?.parameter} `,
      );

    if (!currentNode.parametricNode) {
      currentNode.parametricNode = new Node();
      currentNode.parametricNode.parameter = parameterName;
    }

    currentNode = currentNode.parametricNode;
    return currentNode;
  }

  private registerWildcardSegment(_: string, currentNode: Node): Node {
    if (!currentNode.wildCardNode) currentNode.wildCardNode = new Node();
    currentNode = currentNode.wildCardNode;
    return currentNode;
  }

  private registerOptionalSegment(
    segment: string,
    currentNode: Node,
    method: HTTP_METHODS,
    handlers: RouteHandler[],
    segments: string[],
  ): Node {
    const parameterName = this.getParamName(segment).replace(/\?/, "");
    this.registerHandlers(method, handlers, currentNode, segments);

    if (!currentNode.parametricNode) currentNode.parametricNode = new Node();

    currentNode = currentNode.parametricNode;
    currentNode.parameter = parameterName;
    return currentNode;
  }

  private validateUrl(url: string) {
    if (!url.startsWith("/")) {
      throw new Error(`Invalid URL: ${url}. URL must start with a '/'`);
    }

    if (url.includes("?") && !url.endsWith("?")) {
      throw new Error(
        `Invalid URL: ${url}. Optional parameters can only be at the end of the URL`,
      );
    }

    if (url.includes("*") && !url.endsWith("*")) {
      throw new Error(
        `Invalid URL: ${url}. Wildcard parameters can only be at the end of the URL`,
      );
    }
  }

  private normalizeUrl(url: string) {
    if (this.config.ignoreDuplicateSlashes) {
      url = url.replace(/\/+/g, "/");
    }

    if (this.config.ignoreTrailingSlash) {
      url = url.replace(/\/$/, "");
    }

    return this.splitPath(url);
  }

  private identifySegmentType(segment: string): SEGMENT_TYPE {
    if (segment.startsWith(":") && !segment.endsWith("?"))
      return SEGMENT_TYPE.parametric;

    if (segment.endsWith("*")) return SEGMENT_TYPE.wildcard;

    if (segment.endsWith("?")) return SEGMENT_TYPE.optional;

    return SEGMENT_TYPE.static;
  }

  private registerHandlers(
    method: HTTP_METHODS,
    handlers: RouteHandler[],
    currentNode: Node,
    segments: string[],
  ) {
    if (this.isDuplicatePath(method, currentNode)) {
      throw new Error(`Duplicate routes at: /${segments.join("/")}`);
    }

    currentNode.handlers.set(method, handlers);
  }

  private isDuplicatePath(method: HTTP_METHODS, currentNode: Node) {
    return currentNode.handlers.get(method) ? true : false;
  }

  private getParamName(segment: string) {
    return segment.split(":")[1];
  }

  private splitPath(url: string) {
    if (url === "/") return [""];

    const parts = url.split("/");

    if (parts[0] === "") parts.shift();

    return parts;
  }
}

export { RouteNode, Node, SEGMENT_TYPE, Options };
