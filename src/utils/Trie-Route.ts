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

class RouteNode {
  private root = new Node();
  public config: Options = {
    ignoreDuplicateSlashes: false,
    ignoreTrailingSlash: false,
  };

  constructor(config: Options) {
    this.config = config;
  }

  on(url: string, method: HTTP_METHODS, handlers: RouteHandler[]) {
    let currNode = this.root;
    const segments = this.normalizeUrl(url);

    for (const segment of segments) {
      switch (this.identifySegmentType(segment)) {
        case SEGMENT_TYPE.static:
          currNode = this.registerStaticNode(segment, currNode);
          break;

        case SEGMENT_TYPE.parametric:
          currNode = this.registerParametricNode(segment, currNode);
          break;

        case SEGMENT_TYPE.wildcard:
          currNode = this.registerWildcardSegment(segment, currNode);
          break;

        case SEGMENT_TYPE.optional:
          currNode = this.registerOptionalSegment(
            segment,
            currNode,
            method,
            handlers,
            segments,
          );
          break;

        default:
          break;
      }
    }

    this.registerHandlers(method, handlers, currNode, segments);
  }

  private registerStaticNode(segment: string, currNode: Node): Node {
    if (!currNode.staticNodes.has(segment)) {
      currNode.staticNodes.set(segment, new Node());
    }

    currNode = currNode.staticNodes.get(segment)!;
    return currNode;
  }

  private registerParametricNode(segment: string, currNode: Node): Node {
    const parameterName = this.getParamName(segment);

    if (currNode.parametricNode?.parameter !== parameterName)
      throw new Error(
        `parameter name conflict: ${parameterName} vs ${currNode.parametricNode?.parameter} `,
      );

    if (!currNode.parametricNode) {
      currNode.parametricNode = new Node();
      currNode.parametricNode.parameter = parameterName;
    }

    currNode = currNode.parametricNode;
    return currNode;
  }

  private registerWildcardSegment(segment: string, currNode: Node): Node {
    if (!currNode.wildCardNode) currNode.wildCardNode = new Node();
    currNode = currNode.wildCardNode;
    return currNode;
  }

  private registerOptionalSegment(
    segment: string,
    currNode: Node,
    method: HTTP_METHODS,
    handlers: RouteHandler[],
    segments: string[],
  ): Node {
    const parameterName = this.getParamName(segment).replace(/\?/, "");
    this.registerHandlers(method, handlers, currNode, segments);

    if (!currNode.parametricNode) currNode.parametricNode = new Node();

    currNode = currNode.parametricNode;
    currNode.parameter = parameterName;
    return currNode;
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
    currNode: Node,
    segments: string[],
  ) {
    if (this.isDuplicatePath(method, currNode)) {
      throw new Error(`Duplicate routes at: /${segments.join("/")}`);
    }

    currNode.handlers.set(method, handlers);
  }

  private isDuplicatePath(method: HTTP_METHODS, currNode: Node) {
    return currNode.handlers.get(method) ? true : false;
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

const router = new RouteNode({
  ignoreDuplicateSlashes: true,
  ignoreTrailingSlash: true,
});

//router.on("/users//", HTTP_METHODS.GET, [() => {}]);
// router.on("/users//", HTTP_METHODS.GET, [() => {}]);
// router.on("/users", HTTP_METHODS.GET, [() => {}]);
// router.on("/users/", HTTP_METHODS.GET, [() => {}]);

//router.on("/:id", HTTP_METHODS.GET, [() => {}]);
// router.on("/:userId", HTTP_METHODS.GET, [() => {}]);
// router.on("/:id/:usersId", HTTP_METHODS.GET, [() => {}]);

// router.on("/*", HTTP_METHODS.GET, [() => {}]);
// router.on("/users/*", HTTP_METHODS.GET, [() => {}]);

// optional params
// router.on("/users/:id?", HTTP_METHODS.GET, [() => {}]);
// router.on("/users/*", HTTP_METHODS.GET, [() => {}]);

// conflict detection

router.on("/users/:id/*", HTTP_METHODS.GET, [() => {}]);
router.on("/users/:userId", HTTP_METHODS.GET, [() => {}]);

console.dir(router, { depth: null });
