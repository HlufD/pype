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
                if (!currNode.dynamicChild?.parameterName) {
                    currNode.dynamicChild = {
                        parameterName: segment.split(":")[1],
                        node: new TrieNode()
                    }
                }

                currNode = currNode.dynamicChild.node!
            }

        }


        currNode.handlers = currNode.handlers || new Map();
        handlers = Array.isArray(handlers) ? handlers : [handlers]

        if (!currNode.handlers.get(method)) {
            currNode.handlers.set(method, handlers)
        }
    }

    public find(url: string, method: HTTP_METHODS) {
        const segments = url.split("/").filter((segment) => segment.length != 0)
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
        return { handlers, params }
    }
}


const trie = new Trie()
//trie.insert("//users/profile", HTTP_METHODS.GET, () => { })
trie.insert("//users/profile", HTTP_METHODS.GET, [() => { }, () => { }])
trie.insert("//users/", HTTP_METHODS.GET, () => { })
trie.insert("//users", HTTP_METHODS.POST, () => { })
// trie.insert("/", HTTP_METHODS.GET, () => { })
trie.insert("/users/:id/profile/:userId", HTTP_METHODS.GET, () => { })
trie.insert("/users/:id/profile/:userId", HTTP_METHODS.POST, () => { })

console.dir(trie, { depth: null })

//console.log(trie.find("//users/profile", HTTP_METHODS.GET))
console.log(trie.find("//users", HTTP_METHODS.GET))
console.log(trie.find("//users", HTTP_METHODS.POST))
console.log(trie.find("//users/12345/profile/6789", HTTP_METHODS.POST))

export {
    Trie,
    TrieNode
}
