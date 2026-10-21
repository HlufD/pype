import { RouteHandler } from "../types/route-handler";

/** Information about a registered route, exposed as `req.route`. */
interface RouteMeta {
  /** The path as written in the route definition, relative to its router. */
  path: string;
  /** Where the route's router is mounted, `""` for routes on the app itself. */
  baseUrl: string;
}

/** Result of a successful {@link RouteNode.match}. */
interface MatchResult {
  /** Handlers registered for the matched method and path. */
  handlers: RouteHandler[];
  /** Decoded route params, `"*"` holds the wildcard capture. */
  params: Record<string, string>;
  /** Metadata of the matched route. */
  route: RouteMeta;
  /** Set when a param value has a malformed escape, `params` is then empty. */
  error?: Error;
}

/** Path normalization options. */
interface Options {
  /** Treat `//users///1` like `/users/1`. */
  ignoreDuplicateSlashes?: boolean;
  /** Treat `/users/` like `/users`. */
  ignoreTrailingSlash?: boolean;
  /** `false` matches static path text ignoring ASCII case; param values keep theirs. Default `true`. */
  caseSensitive?: boolean;
}

/** What a node stores for one HTTP method. */
interface RouteEntry {
  handlers: RouteHandler[];
  route: RouteMeta;
}

/** A piece of a route path: static text, a `:param` or a trailing `*`. */
type Token =
  | { type: "static"; value: string }
  | { type: "param"; name: string }
  | { type: "wildcard" };

/** Char code of `"/"`. */
const SLASH = 47;

/**
 * Lowercases ASCII letters only, so the result has the same length and a
 * position in it is the same position in `text`.
 */
export function lowerAscii(text: string) {
  return /[A-Z]/.test(text) ? text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()) : text;
}

/**
 * A node of the radix tree.
 *
 * Static children are found by the first char code of their prefix (nodes
 * have few children, so a linear scan beats a `Map`), then one comparison
 * checks the whole compressed prefix.
 */
class Node {
  /** The static text this node consumes. */
  public prefix: string;
  /** First char code of each static child, parallel to `staticChildren`. */
  public childCodes: number[] = [];
  /** Static children, parallel to `childCodes`. */
  public staticChildren: Node[] = [];
  /** Child that consumes one `:param` segment. */
  public paramChild: Node | null = null;
  /** Name of the param consumed by `paramChild`. */
  public paramName: string | null = null;
  /** Child that consumes the rest of the path. */
  public wildcardChild: Node | null = null;
  /** Routes ending at this node, keyed by HTTP method. */
  public entries = new Map<string, RouteEntry>();
  /** Builds the params object from the values collected on the way here. */
  public buildParams: ParamsBuilder = buildNoParams;

  /** @param prefix - The static text this node consumes. */
  constructor(prefix = "") {
    this.prefix = prefix;
  }

  /**
   * Finds the static child whose prefix starts with `code`.
   *
   * @param code - Char code of the next character in the path.
   */
  getChild(code: number): Node | undefined {
    const codes = this.childCodes;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === code) return this.staticChildren[i];
    }
    return undefined;
  }

  /**
   * Adds or replaces the static child whose prefix starts with `code`.
   *
   * @param code - Char code of the child's first prefix character.
   * @param child - The child node.
   */
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

/**
 * Radix tree (compressed trie) router.
 *
 * Precedence is static > param > wildcard, with backtracking when a more
 * specific branch fails deeper down. Fully static paths are also kept in a
 * hash map, since an exact static match always wins and can skip the tree
 * walk entirely.
 */
class RouteNode {
  private root = new Node();
  private staticRoutes = new Map<string, Map<string, RouteEntry>>();
  public config: Options = {
    ignoreDuplicateSlashes: false,
    ignoreTrailingSlash: false,
  };

  /** @param config - Path normalization options. */
  constructor(config: Options) {
    this.config = config;
  }

  /**
   * Registers a route. An optional last param like `/users/:id?` registers
   * both `/users` and `/users/:id`.
   *
   * @param url - Route path, e.g. `/users/:id` or `/files/*`.
   * @param method - HTTP method the handlers respond to.
   * @param handlers - Handlers returned by {@link RouteNode.match}.
   * @param meta - Route metadata, defaults to `{ path: url, baseUrl: "" }`.
   * @throws When the path is invalid, already registered for `method`, or
   * uses a different param name than an existing route at the same position.
   */
  register(
    url: string,
    method: string,
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

    const optional = /\/:([^/]+)\?$/.exec(path);
    if (optional) {
      const parent = path.slice(0, optional.index) || "/";
      this.insert(parent, method, entry);
      this.insert(`${parent === "/" ? "" : parent}/:${optional[1]}`, method, entry);
      return;
    }

    this.insert(path, method, entry);
  }

  /**
   * Finds the route for a request path.
   *
   * @param url - Request path without the query string.
   * @param method - HTTP method of the request.
   * @returns The matched handlers, decoded params and route metadata, or
   * `null` when nothing matches.
   */
  match(url: string, method: string): MatchResult | null {
    const path = this.normalize(url);
    // Compared folded, while param values are cut from `path` with their case.
    const folded = this.fold(path);

    const staticEntry = this.staticRoutes.get(folded)?.get(method);
    if (staticEntry) {
      return { handlers: staticEntry.handlers, params: {}, route: staticEntry.route };
    }

    const values: string[] = [];
    const node = this.find(this.root, folded, 0, method, values, path);
    if (!node) return null;

    const entry = node.entries.get(method)!;
    try {
      return {
        handlers: entry.handlers,
        params: node.buildParams(values, decode),
        route: entry.route,
      };
    } catch (error) {
      return { handlers: entry.handlers, params: {}, route: entry.route, error: error as Error };
    }
  }

  /**
   * Depth-first search below `node`. A wildcard may capture an empty
   * remainder, so `/files/` matches `/files/*` when trailing slashes are kept.
   *
   * @param values - Collects raw param values, popped again on backtracking.
   * @param source - `path` before case folding, where the values are cut from.
   * @returns The node holding the route for `method`, or `null`.
   */
  private find(
    node: Node,
    path: string,
    index: number,
    method: string,
    values: string[],
    source: string,
  ): Node | null {
    if (index === path.length) {
      if (node.entries.has(method)) return node;

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
        source,
      );
      if (found) return found;
    }

    const param = node.paramChild;
    if (param) {
      let end = path.indexOf("/", index);
      if (end === -1) end = path.length;

      if (end > index) {
        values.push(source.slice(index, end));
        const found = this.find(param, path, end, method, values, source);
        if (found) return found;
        values.pop();
      }
    }

    const wildcard = node.wildcardChild;
    if (wildcard && wildcard.entries.has(method)) {
      values.push(source.slice(index));
      return wildcard;
    }

    return null;
  }

  /**
   * Adds a normalized path to the tree and stores `entry` for `method`.
   *
   * @throws On duplicate routes or conflicting param names.
   */
  private insert(path: string, method: string, entry: RouteEntry) {
    let node = this.root;
    const names: string[] = [];
    const tokens = this.tokenize(path);

    for (const token of tokens) {
      if (token.type === "static") {
        node = this.insertStatic(node, this.fold(token.value));
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
      const key = this.fold(path);
      let methods = this.staticRoutes.get(key);
      if (!methods) this.staticRoutes.set(key, (methods = new Map()));
      methods.set(method, entry);
    }
  }

  /**
   * Walks or creates the static prefix `value` below `node`, splitting
   * existing nodes where prefixes diverge: adding `/uploads` next to
   * `/users` turns the node into `/u` with children `sers` and `ploads`.
   *
   * @returns The node where `value` ends.
   */
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

  /**
   * Splits a path into tokens: `/users/:id/files/*` becomes static
   * `/users/`, param `id`, static `/files/` and a wildcard.
   */
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

  /** Lowercases static path text when matching ignores case. */
  private fold(text: string) {
    return this.config.caseSensitive === false ? lowerAscii(text) : text;
  }

  /** Applies the duplicate and trailing slash options to a path. */
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

  /**
   * Checks a route path before registration.
   *
   * @throws When the path doesn't start with `/`, a `:param` doesn't take a
   * whole segment or has an invalid name, or an optional param or wildcard
   * isn't at the end.
   */
  private validateUrl(url: string) {
    if (!url.startsWith("/")) {
      throw new Error(`Invalid URL: ${url}. URL must start with a '/'`);
    }

    for (const segment of url.split("/")) {
      if (!segment.includes(":")) continue;
      if (!PARAM_SEGMENT.test(segment)) {
        throw new Error(
          `Invalid URL: ${url}. A parameter must take a whole segment and its name must be letters, digits, '_' or '$', got '${segment}'`,
        );
      }
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

/** A whole-segment param: `:name` or `:name?`, the name a JS identifier. */
const PARAM_SEGMENT = /^:[A-Za-z_$][\w$]*\??$/;

/** Creates a route's params object from the raw values of a match. */
type ParamsBuilder = (
  values: string[],
  decode: (value: string) => string,
) => Record<string, string>;

/** Params builder for routes without params. */
const buildNoParams: ParamsBuilder = () => ({});

/**
 * Compiles `(v, d) => ({ "id": d(v[0]), "postId": d(v[1]) })` for a route,
 * so every match creates an object of the same shape instead of adding keys
 * one by one. Names come from route definitions and are JSON-escaped.
 *
 * @param names - Param names in path order, `"*"` for the wildcard.
 */
function compileParamsBuilder(names: string[]): ParamsBuilder {
  if (names.length === 0) return buildNoParams;

  const body = names
    .map((name, i) => `${JSON.stringify(name)}: d(v[${i}])`)
    .join(", ");

  return new Function("v", "d", `return { ${body} };`) as ParamsBuilder;
}

/** Same as `path.includes("//")`, but cheaper for short strings. */
function hasDoubleSlash(path: string) {
  for (let i = 1; i < path.length; i++) {
    if (path.charCodeAt(i) === SLASH && path.charCodeAt(i - 1) === SLASH)
      return true;
  }
  return false;
}

/**
 * Same as `path.startsWith(prefix, index)`, a plain loop optimizes better.
 * Starts at the second character, the child lookup already matched the first.
 */
function hasPrefixAt(path: string, prefix: string, index: number) {
  const length = prefix.length;
  if (index + length > path.length) return false;

  for (let i = 1; i < length; i++) {
    if (path.charCodeAt(index + i) !== prefix.charCodeAt(i)) return false;
  }

  return true;
}

/**
 * Decodes percent-escapes. Values without `%` skip decoding.
 *
 * @throws A 400 error for malformed escapes, same message as Express.
 */
function decode(value: string) {
  if (value.indexOf("%") === -1) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new URIError(`Failed to decode param '${value}'`);
    throw Object.assign(error, { status: 400, statusCode: 400 });
  }
}

export { RouteNode, Node, Options, RouteMeta, MatchResult };
