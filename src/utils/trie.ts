import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

interface DynamicChild {
    parameterName: string,
    node: TrieNode,
}

class TrieNode {
    handlers: Map<HTTP_METHODS, RouteHandler[]> = new Map();
    staticChildren: Map<string, TrieNode> = new Map()
    dynamicChild: DynamicChild | null = null;
}

class Trie {
    private root = new TrieNode();

    public register(url: string, method: HTTP_METHODS, handlers: RouteHandler | RouteHandler[]) {
        const segments = this.normalizePath(url);
        let currNode = this.root as TrieNode

        for (const segment of segments) {
            currNode = this.isDynamicSegment(segment) ?
                this.registerDynamicSegments(segment, currNode) :
                this.registerStaticSegments(segment, currNode)
        }

        this.registerHandlers(method, handlers, currNode)
    }

    public match(url: string, method: HTTP_METHODS) {
        const segments = this.normalizePath(url);
        const params: Record<string, any> = {};
        let currNode = this.root;

        for (const segment of segments) {
            if (currNode.staticChildren.has(segment)) {
                currNode = currNode.staticChildren.get(segment)!
                continue;
            }

            if (currNode.dynamicChild) {
                params[currNode.dynamicChild.parameterName] = segment;
                currNode = currNode.dynamicChild.node
                continue;
            }

            return null
        }

        const handlers = currNode.handlers?.get(method);
        if (!handlers) return null

        return { handlers, params }
    }


    private registerStaticSegments(segment: string, currNode: TrieNode): TrieNode {
        if (!currNode.staticChildren.has(segment)) {
            currNode.staticChildren.set(segment, new TrieNode())
        }

        return currNode.staticChildren.get(segment) as TrieNode;
    }

    private registerDynamicSegments(segment: string, currNode: TrieNode): TrieNode {
        const parameterName = this.getParameterName(segment);

        if (currNode.dynamicChild?.parameterName && parameterName != currNode.dynamicChild?.parameterName) {
            throw new Error(`Conflicting param names :${currNode.dynamicChild?.parameterName} vs :${parameterName}`)
        }

        if (!currNode.dynamicChild?.parameterName) {
            currNode.dynamicChild = {
                parameterName: parameterName,
                node: new TrieNode()
            }
        }

        return currNode.dynamicChild.node
    }

    private registerHandlers(method: HTTP_METHODS, handlers: RouteHandler | RouteHandler[], currNode: TrieNode) {
        handlers = Array.isArray(handlers) ? handlers : [handlers]

        const handlerStack = currNode.handlers.get(method) || []
        handlers = handlerStack.length != 0 ? [...handlerStack, ...handlers] : handlers;

        currNode.handlers.set(method, handlers)
    }

    private normalizePath(path: string) {
        return path.split("/").filter(segment => segment.length > 0)
    }

    private getParameterName(segment: string) {
        return segment.slice(1)
    }

    private isDynamicSegment(segment: string): boolean {
        return segment.startsWith(":")
    }

}


const trie = new Trie()
trie.register("//users/profile", HTTP_METHODS.GET, () => { })
trie.register("/users/profile", HTTP_METHODS.POST, [() => { }, () => { }])
// trie.register("//users/", HTTP_METHODS.GET, () => { })
// trie.register("//users", HTTP_METHODS.GET, () => { })
// trie.register("/", HTTP_METHODS.GET, () => { })
trie.register("/users/:id/profile/:profileId", HTTP_METHODS.GET, () => { })
// trie.register("/users/:id/profile/:userId", HTTP_METHODS.POST, () => { })

// trie.register("/users/:id", HTTP_METHODS.GET, () => { })
// trie.register("/users/:id", HTTP_METHODS.POST, () => { })

trie.register("/", HTTP_METHODS.GET, () => { })

console.dir(trie, { depth: null })

console.log(trie.match("//users/profile", HTTP_METHODS.GET))
// console.log(trie.match("//users", HTTP_METHODS.GET))
// console.log(trie.match("//users", HTTP_METHODS.POST))
console.log(trie.match("//users/12345/profile/6789", HTTP_METHODS.POST))

// wild card
// /user/:id/*
// user/:id?


export {
    Trie,
    TrieNode
}

