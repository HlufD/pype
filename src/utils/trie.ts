import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

interface DynamicChild {
    parameterName: string,
    node: TrieNode,
}

class TrieNode {
    handlers: Map<HTTP_METHODS, RouteHandler[]> | null = null;
    staticChildren: Map<string, TrieNode> | null = null;
    dynamicChild: DynamicChild | null = null;
}

class Trie {
    private root = new TrieNode();

    public insert(url: string, method: HTTP_METHODS, handlers: RouteHandler | RouteHandler[]) {
        const segments = this.normalizePath(url);
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
                const parameterName = segment.split(":")[1]

                if (currNode.dynamicChild?.parameterName && parameterName != currNode.dynamicChild?.parameterName) {
                    throw new Error(`Conflicting param names :${currNode.dynamicChild?.parameterName} vs :${parameterName}`)
                }

                if (!currNode.dynamicChild?.parameterName) {
                    currNode.dynamicChild = {
                        parameterName: parameterName,
                        node: new TrieNode()
                    }
                }

                currNode = currNode.dynamicChild.node!
            }
        }


        currNode.handlers = currNode.handlers || new Map();
        handlers = Array.isArray(handlers) ? handlers : [handlers]

        const handlerStack = currNode.handlers.get(method)
        handlers = handlerStack && handlerStack?.length != 0 ? [...handlerStack!, ...handlers] : handlers;

        currNode.handlers.set(method, handlers)
    }

    public find(url: string, method: HTTP_METHODS) {
        const segments = this.normalizePath(url);
        const params: Record<string, any> = {};
        let currNode = this.root;

        for (const segment of segments) {
            if (currNode.staticChildren?.has(segment)) {
                currNode = currNode.staticChildren.get(segment)!
                continue;
            }

            if (currNode.dynamicChild) {
                params[currNode.dynamicChild?.parameterName!] = segment;
                currNode = currNode.dynamicChild.node
                continue;
            }

            return null
        }

        const handlers = currNode.handlers?.get(method);
        if (!handlers) return null
        return { handlers, params }
    }

    public normalizePath(path: string) {
        return path.split("/").filter(segment => segment.length > 0)
    }

}


const trie = new Trie()
//trie.insert("//users/profile", HTTP_METHODS.GET, () => { })
// trie.insert("//users/profile", HTTP_METHODS.GET, [() => { }, () => { }])
// trie.insert("//users/", HTTP_METHODS.GET, () => { })
// trie.insert("//users", HTTP_METHODS.GET, () => { })
// trie.insert("/", HTTP_METHODS.GET, () => { })
// trie.insert("/users/:id/profile/:userId", HTTP_METHODS.GET, () => { })
// trie.insert("/users/:id/profile/:userId", HTTP_METHODS.POST, () => { })

trie.insert("/user/:id", HTTP_METHODS.GET, () => { })
trie.insert("/user/:id", HTTP_METHODS.GET, () => { })

console.dir(trie, { depth: null })

//console.log(trie.find("//users/profile", HTTP_METHODS.GET))
// console.log(trie.find("//users", HTTP_METHODS.GET))
// console.log(trie.find("//users", HTTP_METHODS.POST))
// console.log(trie.find("//users/12345", HTTP_METHODS.POST))


export {
    Trie,
    TrieNode
}

