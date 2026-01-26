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

interface WildcardState {
  node: Node;
  index: number;
  params: Record<string, any>;
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
    let currentNode = this.root;
    let params: Record<string, any> = {};
    let wildcardState: WildcardState | null = null;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (currentNode.staticNodes.has(segment)) {
        if (currentNode.wildCardNode)
          wildcardState = this.saveWildcardState(currentNode, i, params);

        const staticChild = currentNode.staticNodes.get(segment)!;
        currentNode = staticChild;
      } else if (currentNode.parametricNode) {
        if (currentNode.wildCardNode)
          wildcardState = this.saveWildcardState(currentNode, i, params);

        const parametricChild = currentNode.parametricNode;
        params[parametricChild.parameter!] = segment;
        currentNode = parametricChild;
      } else if (currentNode.wildCardNode) {
        wildcardState = this.saveWildcardState(currentNode, i, params);
        break;
      }
    }

    let handlers = currentNode.handlers.get(method);

    if (!handlers && wildcardState) {
      const { node: wildCardNode, index, params: parameters } = wildcardState;
      handlers = wildCardNode.handlers.get(method);
      params = { ...parameters };
      params["*"] = segments.slice(wildcardState.index).join("/");
    }

    if (!handlers) return null;

    return { handlers, params };
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

  private saveWildcardState(
    node: Node,
    index: number,
    params: Record<string, any>,
  ): WildcardState {
    return {
      node: node.wildCardNode!,
      index,
      params: { ...params },
    };
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
