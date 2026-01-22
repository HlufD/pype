import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

const enum SEGMENT_TYPE {
  "static" = "static",
  "parametric" = "parametric",
  "wildcard" = "wildcard",
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

  on(url: string, method: HTTP_METHODS, ...handlers: RouteHandler[]) {
    let currNode = this.root;
    const segments = this.normalizeUrl(url);

    console.log(segments);

    for (const segment of segments) {
      const segmentType = this.identifySegmentType(segment);
      console.log(segment, segmentType);

      switch (segmentType) {
        case SEGMENT_TYPE.static:
          currNode = this.registerStaticNode(segment, currNode, ...handlers);
        case SEGMENT_TYPE.parametric:

        case SEGMENT_TYPE.wildcard:
      }
    }
  }

  private registerStaticNode(
    segment: string,
    currNode: Node,
    ...handler: RouteHandler[]
  ): Node {
    if (!currNode.staticNodes.has(segment)) {
      currNode.staticNodes.set(segment, new Node());
    }

    currNode = currNode.staticNodes.get(segment)!;

    return currNode;
  }

  private normalizeUrl(url: string) {
    if (url != "/") {
      url = url.replace(/\/+$/, "");
    }

    return url.split("/");
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
}

// const router = new RouteNode();
// router.on("//users//some", HTTP_METHODS.GET, () => {});
// router.on("/users/some", HTTP_METHODS.GET, () => {});

//console.dir(router, { depth: null });
