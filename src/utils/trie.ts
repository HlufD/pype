import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

interface DynamicChildren {
    parameterName: string,
    node: TrieNode,
}

class TrieNode {
    handlers: Map<HTTP_METHODS, RouteHandler[]> | null = null;
    staticChildren: Map<string, TrieNode> | null = null;
    dynamicChildren: DynamicChildren | null = null;
}

class Trie {
    private root = new TrieNode();

    public insert(url: string, method: HTTP_METHODS, handlers: RouteHandler | RouteHandler[]) {
        const segments = url.split("/").filter(segment => segment.length != 0)
        let currNode = this.root as TrieNode

        for (const segment of segments) {
            const isDynamicSegment = segment.startsWith(":")

            if (!isDynamicSegment) {

                if (!currNode.staticChildren) {
                    currNode.staticChildren = new Map()
                }

                if (!currNode.staticChildren.has(segment)) {
                    currNode.staticChildren.set(segment, new TrieNode())
                }

                currNode = currNode.staticChildren.get(segment)!;
            } else if (isDynamicSegment) {
                if (!currNode.dynamicChildren?.parameterName) {
                    currNode.dynamicChildren = {
                        parameterName: segment.split(":")[1],
                        node: new TrieNode()
                    }
                }

                currNode = currNode.dynamicChildren.node!
            }

        }


        currNode.handlers = currNode.handlers || new Map();
        handlers = Array.isArray(handlers) ? handlers : [handlers]

        if (!currNode.handlers.get(method)) {
            currNode.handlers.set(method, handlers)
        }

    }
}

export {
    Trie,
    TrieNode
}
