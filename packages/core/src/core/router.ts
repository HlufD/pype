import { HTTP_METHODS, METHODS } from "../enums/methods.enum";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";
import { hasMixedSegment, pathKeys } from "../utils/path-pattern";

/** Anything `app.use()` and `router.use()` accept, arrays are flattened like Express. */
export type UseHandler = Middleware | ErrorMiddleware | AnyHandler | PypeRouter | UseHandler[];

/** A route handler or a (nested) array of them. */
export type HandlerParam = RouteHandler | AnyHandler | HandlerParam[];

/**
 * HTTP methods without a route method written out below; theirs are added
 * from Node's `http.METHODS`, like Express: `router.purge()`,
 * `router["m-search"]()`.
 */
export type ExtraMethod =
  | "acl" | "bind" | "checkout" | "connect" | "copy" | "link" | "lock" | "m-search"
  | "merge" | "mkactivity" | "mkcalendar" | "mkcol" | "move" | "notify" | "propfind"
  | "proppatch" | "purge" | "query" | "rebind" | "report" | "search" | "source"
  | "subscribe" | "trace" | "unbind" | "unlink" | "unlock" | "unsubscribe";

/** Route methods for {@link ExtraMethod}, returning `T` for chaining. */
export type ExtraRouteMethods<T> = {
  [M in ExtraMethod]: (path: PathParam, ...handlers: HandlerParam[]) => T;
};

/** Bumped on every registration so apps know to rebuild their routing table. */
let version = 0;

/** Current registration counter, compared by apps to detect changes. */
export const routingVersion = () => version;

/** A route or mount path: a pattern string, a regular expression, or an array of them. */
export type PathParam = string | RegExp | Array<string | RegExp>;

/** Something registered on a router, in registration order. */
type StackEntry =
  | { type: "use"; path: PathParam; handlers: AnyHandler[] }
  | { type: "router"; path: PathParam; router: PypeRouter }
  | { type: "route"; path: PathParam; methods: string[]; handlers: AnyHandler[] };

/** Options of {@link PypeRouter}, like Express's `Router()` options. */
export interface RouterOptions {
  /**
   * Keep the params of the paths this router is mounted on in `req.params`,
   * like Express. Default `false`: a router only sees its own paths' params.
   */
  mergeParams?: boolean;
}

/**
 * One router a layer is nested in, with the params of the path the next
 * router down is mounted on there; Express sets `req.params` router by router.
 */
export interface MountScope {
  /** The router the mount path was registered on. */
  router: PypeRouter;
  /** Parameter names in that mount path. */
  keys: string[];
  /** The mount path with every prefix above it, where the params are read from. */
  path: string;
}

/** A middleware function with its resolved mount path. */
export interface MiddlewareLayer {
  kind: "middleware";
  /** Full mount path, the middleware runs for this path and below it. With `pattern`, the router's mount path. */
  path: string;
  /** A regular expression mount path, matched against the path below `path`. */
  pattern?: RegExp;
  /** A string mount path with several params in a segment, compiled into `pattern` by the app. */
  pathPattern?: string;
  /** Shared by the layers of one array mount path, so the middleware runs once per request. */
  group?: object;
  /** The middleware or error middleware. */
  handle: AnyHandler;
  /** Routers this layer belongs to, outermost first. */
  routers: PypeRouter[];
  /** Parameter names in the middleware's own mount path, without its routers' mount paths. */
  keys: string[];
  /** Mount paths of the routers this layer is nested in, outermost first. */
  mounts: MountScope[];
}

/** A route with its resolved paths. */
export interface RouteLayer {
  kind: "route";
  /** Path including every mount prefix, used for matching. With `pattern`, the router's mount path. */
  fullPath: string;
  /** Path as written in the route definition, exposed as `req.route.path`; a RegExp or array when the route was defined with one. */
  routePath: PathParam;
  /** A regular expression route path, matched against the path below `fullPath`. */
  pattern?: RegExp;
  /** A string route path with several params in a segment, compiled into `pattern` by the app. */
  pathPattern?: string;
  /** Shared by the layers of one array path, so the route runs once per request. */
  group?: object;
  /** Mount path of the route's router, exposed as `req.baseUrl`. */
  baseUrl: string;
  /** HTTP methods the route responds to, in lower case. */
  methods: string[];
  /** Handlers, run in order. */
  handlers: AnyHandler[];
  /** Routers this layer belongs to, outermost first. */
  routers: PypeRouter[];
  /** Parameter names in the route path, in order; `"*"` for the wildcard. */
  keys: string[];
  /** Mount paths of the routers this layer is nested in, outermost first. */
  mounts: MountScope[];
}

/**
 * A `param()` callback: runs before the route handlers of routes with that
 * parameter, like Express's `app.param()`.
 */
export type ParamHandler = (req: any, res: any, next: (err?: any) => void, value: string, name: string) => any;

/**
 * Marks where a mounted router's layers end. Express answers automatic
 * OPTIONS requests when a router is done, from the routes it saw.
 */
export interface RouterEndLayer {
  kind: "end";
  /** The router whose layers end here. */
  router: PypeRouter;
  /** Routers this marker belongs to, outermost first, including `router`. */
  routers: PypeRouter[];
  group?: object;
}

/** One step of the request pipeline. */
export type Layer = MiddlewareLayer | RouteLayer | RouterEndLayer;

export interface RouteBuilder extends Record<ExtraMethod, (...handlers: HandlerParam[]) => RouteBuilder> {}

/** Chainable route definition returned by {@link PypeRouter.route}. */
export class RouteBuilder {
  /**
   * @param path - Path every route in the chain is registered on.
   * @param router - Router the routes are added to.
   */
  constructor(
    private path: PathParam,
    private router: PypeRouter,
  ) {}

  /** Adds handlers for every HTTP method on this path. */
  all(...handlers: HandlerParam[]): this {
    this.router.all(this.path, ...handlers);
    return this;
  }

  /** Adds GET handlers on this path. */
  get(...handlers: HandlerParam[]): this {
    this.router.get(this.path, ...handlers);
    return this;
  }

  /** Adds POST handlers on this path. */
  post(...handlers: HandlerParam[]): this {
    this.router.post(this.path, ...handlers);
    return this;
  }

  /** Adds PUT handlers on this path. */
  put(...handlers: HandlerParam[]): this {
    this.router.put(this.path, ...handlers);
    return this;
  }

  /** Adds DELETE handlers on this path. */
  delete(...handlers: HandlerParam[]): this {
    this.router.delete(this.path, ...handlers);
    return this;
  }

  /** Adds PATCH handlers on this path. */
  patch(...handlers: HandlerParam[]): this {
    this.router.patch(this.path, ...handlers);
    return this;
  }

  /** Adds HEAD handlers on this path. */
  head(...handlers: HandlerParam[]): this {
    this.router.head(this.path, ...handlers);
    return this;
  }

  /** Adds OPTIONS handlers on this path. */
  options(...handlers: HandlerParam[]): this {
    this.router.options(this.path, ...handlers);
    return this;
  }
}

export interface PypeRouter extends ExtraRouteMethods<PypeRouter> {}

/**
 * Express-style router: middleware, routes and sub-routers run in the order
 * they are registered.
 */
export class PypeRouter {
  private readonly stack: StackEntry[] = [];

  /** Whether `req.params` keeps the params of this router's mount paths, see {@link RouterOptions.mergeParams}. */
  readonly mergeParams: boolean;

  /**
   * @param options - Router options, see {@link RouterOptions}.
   */
  constructor(options: RouterOptions = {}) {
    this.mergeParams = Boolean(options.mergeParams);
  }

  /** `param()` callbacks by parameter name. */
  readonly params: Record<string, ParamHandler[]> = Object.create(null);

  /** Whether `param()` was called, checked on every request instead of counting `params`. */
  hasParams = false;

  /**
   * Adds a callback for a route parameter, like Express's `router.param()`.
   * It runs before the handlers of this router's routes that have the
   * parameter, once per request and value, with
   * `(req, res, next, value, name)`. `next(err)` and rejected promises go to
   * error middleware, `next("route")` skips the route.
   *
   * @throws When the name isn't a string or `fn` isn't a function, with
   * Express's messages.
   */
  param(name: string, fn: ParamHandler): this {
    if (!name) throw new TypeError("argument name is required");
    if (typeof name !== "string") throw new TypeError("argument name must be a string");
    if (!fn) throw new TypeError("argument fn is required");
    if (typeof fn !== "function") throw new TypeError("argument fn must be a function");

    (this.params[name] ??= []).push(fn);
    this.hasParams = true;
    return this;
  }

  /**
   * Adds middleware, error middleware or sub-routers. With a path, they only
   * run for that path and below it, and see `req.url`, `req.path` and
   * `req.baseUrl` relative to it.
   *
   * @param path - Optional mount path, defaults to `/`: a string, a regular
   * expression (matched at the start, ending at a `/`), or an array of them.
   * @param handlers - Middleware functions, routers, or arrays of them.
   * @throws When no handler is given, a handler isn't a function or router,
   * or a router is mounted on a regular expression.
   */
  use(...handlers: Array<Middleware | Middleware[]>): this;
  use(path: PathParam, ...handlers: Array<Middleware | Middleware[] | PypeRouter>): this;
  use(...handlers: ErrorMiddleware[]): this;
  use(path: PathParam, ...handlers: ErrorMiddleware[]): this;
  use(...handlers: UseHandler[]): this;
  use(path: PathParam, ...handlers: UseHandler[]): this;
  use(...args: Array<PathParam | UseHandler>): this {
    const path = isPathArgument(args[0]) ? (args.shift() as PathParam) : "/";
    const handlers = (args as unknown[]).flat(Infinity) as Array<
      AnyHandler | PypeRouter
    >;

    if (handlers.length === 0) {
      throw new TypeError("use() requires a middleware function or router");
    }

    let pending: AnyHandler[] = [];
    const flush = () => {
      if (pending.length) this.stack.push({ type: "use", path, handlers: pending });
      pending = [];
    };

    for (const handler of handlers) {
      if (handler instanceof PypeRouter) {
        if ([path].flat().some((each) => each instanceof RegExp)) {
          throw new TypeError("Mounting a router on a regular expression is not supported");
        }
        if ([path].flat().some((each) => typeof each === "string" && hasMixedSegment(each))) {
          throw new TypeError("Mounting a router on a path with several params in one segment is not supported");
        }
        flush();
        this.stack.push({ type: "router", path, router: handler });
      } else if (typeof handler === "function") {
        pending.push(handler);
      } else {
        throw new TypeError(
          `use() requires a middleware function but got a ${typeof handler}`,
        );
      }
    }

    flush();
    version++;
    return this;
  }

  /**
   * Adds a route for every HTTP method.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  all(path: PathParam, ...handlers: RouteHandler[]): this;
  all(path: PathParam, ...handlers: HandlerParam[]): this;
  all(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, METHODS, handlers);
  }

  /**
   * Adds a GET route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  get(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  get(path: PathParam, ...handlers: HandlerParam[]): this;
  get(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.GET], handlers);
  }

  /**
   * Adds a POST route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  post(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  post(path: PathParam, ...handlers: HandlerParam[]): this;
  post(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.POST], handlers);
  }

  /**
   * Adds a PUT route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  put(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  put(path: PathParam, ...handlers: HandlerParam[]): this;
  put(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.PUT], handlers);
  }

  /**
   * Adds a DELETE route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  delete(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  delete(path: PathParam, ...handlers: HandlerParam[]): this;
  delete(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.DELETE], handlers);
  }

  /**
   * Adds a PATCH route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  patch(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  patch(path: PathParam, ...handlers: HandlerParam[]): this;
  patch(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.PATCH], handlers);
  }

  /**
   * Adds a HEAD route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  head(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  head(path: PathParam, ...handlers: HandlerParam[]): this;
  head(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.HEAD], handlers);
  }

  /**
   * Adds a OPTIONS route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  options(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  options(path: PathParam, ...handlers: HandlerParam[]): this;
  options(path: PathParam, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.OPTIONS], handlers);
  }

  /**
   * Starts a chainable route definition for one path.
   *
   * @example router.route("/users").get(list).post(create)
   */
  route(path: PathParam) {
    return new RouteBuilder(path, this);
  }

  /**
   * Flattens this router and its sub-routers into layers, in registration
   * order, with mount paths resolved.
   *
   * @param basePath - Mount path of this router.
   * @param routers - Routers this one is nested in, outermost first.
   * @param mounts - Mount paths of those routers, see {@link MountScope}.
   */
  compile(basePath = "", routers: PypeRouter[] = [], mounts: MountScope[] = []): Layer[] {
    const chain = [...routers, this];
    const layers: Layer[] = [];

    for (const entry of this.stack) {
      const paths = [entry.path].flat();
      // The layers of one array path share a group and run once per request.
      const group = paths.length > 1 ? {} : undefined;

      if (entry.type === "router") {
        // Each mount path gets its own copy of the router's layers; copy i of
        // every layer shares a group, so only the first matching mount runs it.
        const copies = paths.map((path) => [
          ...entry.router.compile(joinPaths(basePath, path as string), chain, [
            ...mounts,
            { router: this, keys: paramKeys(path as string), path: joinPaths(basePath, path as string) },
          ]),
          { kind: "end", router: entry.router, routers: [...chain, entry.router] } as RouterEndLayer,
        ]);
        copies[0].forEach((_, index) => {
          const shared = group && {};
          for (const copy of copies) layers.push(shared ? { ...copy[index], group: shared } : copy[index]);
        });
        continue;
      }

      for (const path of paths) {
        // Like RegExp paths, a path with several params in one segment is
        // matched below the router's mount path, by a pattern.
        const pathPattern = typeof path === "string" && hasMixedSegment(path) ? path : undefined;
        const below = path instanceof RegExp || pathPattern !== undefined;
        const keys = path instanceof RegExp ? [] : pathPattern ? pathKeys(path) : paramKeys(path);

        if (entry.type === "use") {
          const mount = below ? trimSlashes(basePath) : joinPaths(basePath, path as string);
          const pattern = path instanceof RegExp ? statelessPattern(path) : undefined;
          for (const handle of entry.handlers) {
            layers.push({ kind: "middleware", path: mount, pattern, pathPattern, handle, routers: chain, keys, mounts, group });
          }
        } else {
          layers.push({
            kind: "route",
            fullPath: below ? trimSlashes(basePath) : joinPaths(basePath, path as string),
            routePath: entry.path,
            pattern: path instanceof RegExp ? statelessPattern(path) : undefined,
            pathPattern,
            baseUrl: trimSlashes(basePath),
            methods: entry.methods,
            handlers: [...entry.handlers],
            routers: chain,
            keys,
            mounts,
            group,
          });
        }
      }
    }

    return layers;
  }

  /**
   * Records a route on the stack.
   *
   * @throws When no handlers are given or one isn't a function.
   */
  private addRoute(path: PathParam, methods: string[], handlers: HandlerParam[]) {
    const flat = (handlers as unknown[]).flat(Infinity) as AnyHandler[];

    if (flat.length === 0 || flat.some((h) => typeof h !== "function")) {
      throw new TypeError(`Route ${path} requires handler functions`);
    }

    this.stack.push({ type: "route", path, methods, handlers: flat });
    version++;
    return this;
  }
}

// Every other HTTP method gets a route method too, like in Express.
for (const method of METHODS) {
  if (Object.prototype.hasOwnProperty.call(PypeRouter.prototype, method)) continue;
  Object.defineProperty(PypeRouter.prototype, method, {
    configurable: true,
    writable: true,
    value(this: PypeRouter, path: PathParam, ...handlers: HandlerParam[]) {
      return (this as any).addRoute(path, [method], handlers);
    },
  });
  Object.defineProperty(RouteBuilder.prototype, method, {
    configurable: true,
    writable: true,
    value(this: RouteBuilder, ...handlers: HandlerParam[]) {
      (this as any).router[method]((this as any).path, ...handlers);
      return this;
    },
  });
}

/**
 * Whether the first `use()` argument is a mount path rather than a handler,
 * the test Express uses: a string, a RegExp, or an array whose first leaf
 * isn't a function or router.
 */
function isPathArgument(arg: unknown): boolean {
  let first = arg;
  while (Array.isArray(first) && first.length > 0) first = first[0];
  return typeof first === "string" || first instanceof RegExp;
}

/** Parameter names of a route path: `/users/:id/*` gives `["id", "*"]`. */
function paramKeys(path: string): string[] {
  const keys: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.startsWith(":")) keys.push(segment.slice(1).replace(/\?$/, ""));
    else if (segment.endsWith("*")) keys.push("*");
  }
  return keys;
}

/**
 * A copy of a regular expression path without the `g` and `y` flags, whose
 * `lastIndex` would carry over from one request to the next and make the
 * same URL match only every other time. The caller's RegExp is left alone.
 */
function statelessPattern(pattern: RegExp) {
  return pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
}

/** Collapses repeated slashes and drops trailing ones. */
function trimSlashes(path: string) {
  return path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** Joins a mount path and a child path: `/api` + `users` is `/api/users`. */
function joinPaths(base: string, path: string) {
  return trimSlashes(base) + (path.startsWith("/") ? path : `/${path}`);
}
