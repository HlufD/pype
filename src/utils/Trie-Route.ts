import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";

interface RouteMeta {
  // The path as written in the route definition (relative to its router).
  path: string;
  // Where the route's router is mounted, "" for routes on the app itself.
  baseUrl: string;
}

interface MatchResult {
  handlers: RouteHandler[];
  params: Record<string, string>;
  route: RouteMeta;
}

interface Options {
  ignoreDuplicateSlashes?: boolean;
  ignoreTrailingSlash?: boolean;
}

interface RouteEntry {
  handlers: RouteHandler[];
  route: RouteMeta;
}

type Token =
  | { type: "static"; value: string }
  | { type: "param"; name: string }
  | { type: "wildcard" };

const SLASH = 47; // "/"

// A node of the radix tree. Static children are found by the first char code
// of their prefix (nodes have few children, so a linear scan beats a Map),
// then one startsWith() checks the whole compressed prefix.
class Node {
  public prefix: string;
  public childCodes: number[] = [];
  public staticChildren: Node[] = [];
  public paramChild: Node | null = null;
  public paramName: string | null = null;
  public wildcardChild: Node | null = null;
  public entries = new Map<string, RouteEntry>();
  // Builds the params object from the values collected on the way here.
  public buildParams: ParamsBuilder = buildNoParams;

  constructor(prefix = "") {
    this.prefix = prefix;
  }

  getChild(code: number): Node | undefined {
    const codes = this.childCodes;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === code) return this.staticChildren[i];
    }
    return undefined;
  }

  setChild(code: number, child: Node) {
    const i = this.childCodes.indexOf(code);
    if (i === -1) {
      this.childCodes.push(code);
      this.staticChildren.push(child);
    } else {
      this.staticChildren[i] = child;
    }
  }
}

// Radix tree (compressed trie) router. Precedence is static > param >
// wildcard, with backtracking when a more specific branch fails deeper down.
class RouteNode {
  private root = new Node();
  // Fully static paths are also kept in a hash map: an exact static match
  // always wins, so it can skip the tree walk entirely.
  private staticRoutes = new Map<string, Map<string, RouteEntry>>();
  public config: Options = {
    ignoreDuplicateSlashes: false,
    ignoreTrailingSlash: false,
  };

  constructor(config: Options) {
    this.config = config;
  }

  register(
    url: string,
    method: HTTP_METHODS,
    handlers: RouteHandler[],
    meta: Partial<RouteMeta> = {},
  ) {
    this.validateUrl(url);

    const path = this.normalize(url);
    const route: RouteMeta = {
      path: meta.path ?? url,
      baseUrl: meta.baseUrl ?? "",
    };
    const entry: RouteEntry = { handlers, route };

    // "/users/:id?" registers "/users" and "/users/:id".
    const optional = /\/:([^/]+)\?$/.exec(path);
    if (optional) {
      const parent = path.slice(0, optional.index) || "/";
      this.insert(parent, method, entry);
      this.insert(`${parent === "/" ? "" : parent}/:${optional[1]}`, method, entry);
      return;
    }

    this.insert(path, method, entry);
  }

  match(url: string, method: HTTP_METHODS): MatchResult | null {
    const path = this.normalize(url);

    const staticEntry = this.staticRoutes.get(path)?.get(method);
    if (staticEntry) {
      return { handlers: staticEntry.handlers, params: {}, route: staticEntry.route };
    }

    const values: string[] = [];
    const node = this.find(this.root, path, 0, method, values);
    if (!node) return null;

    const entry = node.entries.get(method)!;
    return {
      handlers: entry.handlers,
      params: node.buildParams(values, decode),
      route: entry.route,
    };
  }

  private find(
    node: Node,
    path: string,
    index: number,
    method: string,
    values: string[],
  ): Node | null {
    if (index === path.length) {
      if (node.entries.has(method)) return node;

      // a wildcard may capture an empty remainder: "/files/" for "/files/*"
      const wildcard = node.wildcardChild;
      if (wildcard && wildcard.entries.has(method)) {
        values.push("");
        return wildcard;
      }

      return null;
    }

    const child = node.getChild(path.charCodeAt(index));
    if (child && hasPrefixAt(path, child.prefix, index)) {
      const found = this.find(
        child,
        path,
        index + child.prefix.length,
        method,
        values,
      );
      if (found) return found;
    }

    const param = node.paramChild;
    if (param) {
      let end = path.indexOf("/", index);
      if (end === -1) end = path.length;

      if (end > index) {
        values.push(path.slice(index, end));
        const found = this.find(param, path, end, method, values);
        if (found) return found;
        values.pop();
      }
    }

    const wildcard = node.wildcardChild;
    if (wildcard && wildcard.entries.has(method)) {
      values.push(path.slice(index));
      return wildcard;
    }

    return null;
  }

  private insert(path: string, method: string, entry: RouteEntry) {
    let node = this.root;
    const names: string[] = [];
    const tokens = this.tokenize(path);

    for (const token of tokens) {
      if (token.type === "static") {
        node = this.insertStatic(node, token.value);
      } else if (token.type === "param") {
        if (node.paramChild && node.paramName !== token.name) {
          throw new Error(
            `parameter name conflict: ${token.name} vs ${node.paramName} `,
          );
        }
        if (!node.paramChild) {
          node.paramChild = new Node();
          node.paramName = token.name;
        }
        names.push(token.name);
        node = node.paramChild;
      } else {
        if (!node.wildcardChild) node.wildcardChild = new Node();
        names.push("*");
        node = node.wildcardChild;
      }
    }

    if (node.entries.has(method)) {
      throw new Error(`Duplicate routes at: ${path}`);
    }

    node.entries.set(method, entry);
    node.buildParams = compileParamsBuilder(names);

    if (tokens.every((token) => token.type === "static")) {
      let methods = this.staticRoutes.get(path);
      if (!methods) this.staticRoutes.set(path, (methods = new Map()));
      methods.set(method, entry);
    }
  }

  // Walks or creates the static prefix `value` below `node`, splitting
  // existing nodes where prefixes diverge.
  private insertStatic(node: Node, value: string): Node {
    while (value.length > 0) {
      const code = value.charCodeAt(0);
      const child = node.getChild(code);

      if (!child) {
        const created = new Node(value);
        node.setChild(code, created);
        return created;
      }

      const prefix = child.prefix;
      const max = Math.min(prefix.length, value.length);
      let common = 0;
      while (common < max && prefix.charCodeAt(common) === value.charCodeAt(common)) {
        common++;
      }

      if (common < prefix.length) {
        // split: "/users" + "/uploads" -> "/u" with children "sers", "ploads"
        const parent = new Node(prefix.slice(0, common));
        child.prefix = prefix.slice(common);
        parent.setChild(child.prefix.charCodeAt(0), child);
        node.setChild(code, parent);
        node = parent;
      } else {
        node = child;
      }

      value = value.slice(common);
    }

    return node;
  }

  // "/users/:id/files/*" -> static "/users/", param id, static "/files/", wildcard
  private tokenize(path: string): Token[] {
    const tokens: Token[] = [];
    let staticPart = "";

    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (i > 0) staticPart += "/";

      if (segment.startsWith(":")) {
        tokens.push({ type: "static", value: staticPart });
        tokens.push({ type: "param", name: segment.slice(1) });
        staticPart = "";
      } else if (segment.endsWith("*")) {
        tokens.push({ type: "static", value: staticPart + segment.slice(0, -1) });
        tokens.push({ type: "wildcard" });
        staticPart = "";
      } else {
        staticPart += segment;
      }
    }

    if (staticPart) tokens.push({ type: "static", value: staticPart });

    return tokens.filter((t) => t.type !== "static" || t.value !== "");
  }

  private normalize(url: string) {
    let path = url;

    if (this.config.ignoreDuplicateSlashes && hasDoubleSlash(path)) {
      path = path.replace(/\/+/g, "/");
    }

    if (
      this.config.ignoreTrailingSlash &&
      path.length > 1 &&
      path.charCodeAt(path.length - 1) === SLASH
    ) {
      path = path.slice(0, -1);
    }

    return path;
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
}

type ParamsBuilder = (
  values: string[],
  decode: (value: string) => string,
) => Record<string, string>;

const buildNoParams: ParamsBuilder = () => ({});

// Compiles `(v, d) => ({ "id": d(v[0]), "postId": d(v[1]) })` for a route,
// so every match creates an object of the same shape instead of adding keys
// one by one. Names come from route definitions and are JSON-escaped.
function compileParamsBuilder(names: string[]): ParamsBuilder {
  if (names.length === 0) return buildNoParams;

  const body = names
    .map((name, i) => `${JSON.stringify(name)}: d(v[${i}])`)
    .join(", ");

  return new Function("v", "d", `return { ${body} };`) as ParamsBuilder;
}

// Same as path.includes("//"), but cheaper for short strings.
function hasDoubleSlash(path: string) {
  for (let i = 1; i < path.length; i++) {
    if (path.charCodeAt(i) === SLASH && path.charCodeAt(i - 1) === SLASH)
      return true;
  }
  return false;
}

// Same as path.startsWith(prefix, index); a plain loop optimizes better.
function hasPrefixAt(path: string, prefix: string, index: number) {
  const length = prefix.length;
  if (index + length > path.length) return false;

  for (let i = 1; i < length; i++) {
    // char 0 was already matched by the child lookup
    if (path.charCodeAt(index + i) !== prefix.charCodeAt(i)) return false;
  }

  return true;
}

// Decodes percent-escapes; values without "%" skip decoding entirely.
function decode(value: string) {
  if (value.indexOf("%") === -1) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}


export { RouteNode, Node, Options, RouteMeta, MatchResult };
