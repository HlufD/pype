import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

const enum SEGMENT_TYPE {
  "static" = "static",
  "parametric" = "parametric",
  "wildcard" = "wildcard",
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
    this.wildCardNode = null;
    this.parametricNode = null;
    this.parameter = null;
  }
}

class RouteNode {
  private root = new Node();
  public config: Options = {};

  constructor(config: Options) {
    this.config = config;
  }

  on(url: string, method: HTTP_METHODS, handlers: RouteHandler[]) {
    let currNode = this.root;
    const segments = this.normalizeUrl(url);
    console.log(segments);

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

    if (!currNode.parametricNode) {
      currNode.parametricNode = new Node();
      currNode.parametricNode.parameter = parameterName;
    }

    currNode = currNode.parametricNode;
    return currNode;
  }

  private registerWildcardSegment(segment: string, currNode: Node): Node {
    currNode.wildCardNode = new Node();
    currNode = currNode.wildCardNode;
    return currNode;
  }

  private normalizeUrl(url: string) {
    if (this.config.ignoreDuplicateSlashes) {
      return url.split("/").filter(Boolean);
    } else {
      url = url.replace(/\/+$/, "");
      return url.split("/");
    }
  }

  private identifySegmentType(segment: string): SEGMENT_TYPE {
    if (segment.startsWith(":")) {
      return SEGMENT_TYPE.parametric;
    }

    if (segment.endsWith("*")) {
      return SEGMENT_TYPE.wildcard;
    }

    return SEGMENT_TYPE.static;
  }

  private registerHandlers(
    method: HTTP_METHODS,
    handlers: RouteHandler[],
    currNode: Node,
    segments: string[],
  ) {
    if (
      this.config.ignoreDuplicateSlashes &&
      this.isDuplicatePath(method, currNode)
    ) {
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
}

const router = new RouteNode({
  ignoreDuplicateSlashes: false,
  ignoreTrailingSlash: false,
});

router.on("/", HTTP_METHODS.GET, [() => {}]);
// router.on("//users//some", HTTP_METHODS.GET, () => {});
//router.on("/users/some", HTTP_METHODS.GET, () => {});
// router.on("/:id", HTTP_METHODS.GET, [() => {}]);
// router.on("/*", HTTP_METHODS.GET, [() => {}]);

console.dir(router, { depth: null });
