import type { IncomingMessage, ServerResponse } from "http";
import { HTTP_METHODS, METHODS } from "../enums/methods.enum";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";
import { invoke, once } from "./invoke";
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
  | { type: "route"; path: PathParam; route: Route };

/** Options of {@link PypeRouter}, like Express's `Router()` options. */
export interface RouterOptions {
  /**
   * Keep the params of the paths this router is mounted on in `req.params`,
   * like Express. Default `false`: a router only sees its own paths' params.
   */
  mergeParams?: boolean;
  /**
   * Match this router's own paths ignoring case (`false`) or not (`true`),
   * like Express's option. Default: the app's `"case sensitive routing"`.
   */
  caseSensitive?: boolean;
  /**
   * Make a trailing slash count in this router's own paths, like Express's
   * option. Default: the app's `"strict routing"`.
   */
  strict?: boolean;
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
  /** A string mount path matched by a pattern below `path`, compiled into `pattern` by the app. */
  pathPattern?: string;
  /** The mount path as registered on its router, for a string path. */
  ownPath?: string;
  /** The router's mount path, which `path` starts with. */
  base: string;
  /**
   * Whether each segment of `path` is matched with case, when a router it
   * is nested in has another `caseSensitive` than the app; set by the app.
   */
  caseMask?: boolean[];
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
  /** A string route path matched by a pattern below `fullPath`, compiled into `pattern` by the app. */
  pathPattern?: string;
  /** The route path as registered on its router, for a string path. */
  ownPath?: string;
  /** See {@link MiddlewareLayer.caseMask}; covers `baseUrl` when the route has a pattern. */
  caseMask?: boolean[];
  /** Shared by the layers of one array path, so the route runs once per request. */
  group?: object;
  /** Mount path of the route's router, exposed as `req.baseUrl`. */
  baseUrl: string;
  /** HTTP methods the route responds to, in lower case; `METHODS` itself after `all()`. */
  methods: string[];
  /** The route, which runs its handlers for the request's method. */
  route: Route;
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
  /** The router's full mount path. */
  path: string;
  /** Mount paths of the routers above, the router's own last, for its mount path's `param()` callbacks. */
  mounts: MountScope[];
  group?: object;
}

/** One step of the request pipeline. */
export type Layer = MiddlewareLayer | RouteLayer | RouterEndLayer;

/** A handler of a {@link Route}, for one method, or for every method without one. */
export interface RouteStackLayer {
  method?: string;
  handle: AnyHandler;
}

export interface Route extends Record<ExtraMethod, (...handlers: HandlerParam[]) => Route> {}

/**
 * A path's handlers by method, like Express's `Route`: `app.route(path)`
 * returns one, and each `app.get(path, ...)` and the like makes one. Its
 * handlers run in order for the methods they were added for, so in
 * `app.route("/x").get(a).all(onError)` the error handler sees `a`'s errors.
 * `req.route` is the route that runs.
 */
export class Route {
  /** The path as registered, a string, RegExp or array; `req.route.path`. */
  readonly path: PathParam;
  /** The handlers in order, with the method each one is for. */
  readonly stack: RouteStackLayer[] = [];
  /** The methods the route has handlers for, `_all` after `all()`, like Express. */
  readonly methods: Record<string, boolean> = Object.create(null);

  /** @param path - The path the route is for. */
  constructor(path: PathParam) {
    this.path = path;
  }

  /** Adds handlers for every HTTP method. */
  all(...handlers: HandlerParam[]): this {
    return this.add(undefined, handlers);
  }

  /** Adds GET handlers. */
  get(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.GET, handlers);
  }

  /** Adds POST handlers. */
  post(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.POST, handlers);
  }

  /** Adds PUT handlers. */
  put(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.PUT, handlers);
  }

  /** Adds DELETE handlers. */
  delete(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.DELETE, handlers);
  }

  /** Adds PATCH handlers. */
  patch(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.PATCH, handlers);
  }

  /** Adds HEAD handlers. */
  head(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.HEAD, handlers);
  }

  /** Adds OPTIONS handlers. */
  options(...handlers: HandlerParam[]): this {
    return this.add(HTTP_METHODS.OPTIONS, handlers);
  }

  /** Whether the route has handlers for `method`; HEAD uses GET's when it has none, like Express. */
  _handlesMethod(method?: string): boolean {
    if (this.methods._all) return true;
    let name = typeof method === "string" ? method.toLowerCase() : method;
    if (name === HTTP_METHODS.HEAD && !this.methods.head) name = HTTP_METHODS.GET;
    return Boolean(name && this.methods[name]);
  }

  /** The route's methods in upper case, HEAD with GET, for an automatic OPTIONS answer. */
  _methods(): string[] {
    const methods = Object.keys(this.methods);
    if (this.methods.get && !this.methods.head) methods.push(HTTP_METHODS.HEAD);
    return methods.map((method) => method.toUpperCase());
  }

  /**
   * Runs the handlers for the request's method, like Express's
   * `route.dispatch()`: four-parameter handlers only get errors, a throw or
   * rejected promise is `next(err)`, `next("route")` leaves the route and
   * `next("router")` its router. `done` gets whatever is left. Sets
   * `req.route` to this route.
   */
  dispatch(req: any, res: any, done: (err?: any) => void) {
    const stack = this.stack;
    if (stack.length === 0) return done();

    let method = typeof req.method === "string" ? req.method.toLowerCase() : req.method;
    if (method === HTTP_METHODS.HEAD && !this.methods.head) method = HTTP_METHODS.GET;
    req.route = this;

    let index = 0;
    // Like Express, a long synchronous run goes on on the next tick now and then.
    let sync = 0;
    const next = (err?: any): void => {
      if (err === "route") return done();
      if (err === "router") return done(err);
      if (++sync > 100) {
        setImmediate(next, err);
        return;
      }

      while (index < stack.length) {
        const layer = stack[index++];
        if (layer.method && layer.method !== method) continue;
        if (Boolean(err) !== (layer.handle.length === 4)) continue;
        invoke(layer.handle, err, req, res, once(next));
        sync = 0;
        return;
      }

      done(err);
    };
    next();
  }

  /**
   * Adds handlers for a method, `undefined` for all of them.
   *
   * @throws Express's TypeErrors without handlers, or for one that isn't a function.
   */
  private add(method: string | undefined, handlers: HandlerParam[]): this {
    const flat = (handlers as unknown[]).flat(Infinity) as AnyHandler[];
    if (flat.length === 0) throw new TypeError("argument handler is required");
    if (flat.some((handle) => typeof handle !== "function")) throw new TypeError("argument handler must be a function");

    for (const handle of flat) this.stack.push({ method, handle });
    this.methods[method ?? "_all"] = true;
    version++;
    return this;
  }
}

/** The old name of {@link Route}, from before routes were Express's Route. */
export const RouteBuilder = Route;
export type RouteBuilder = Route;

/**
 * Like an Express router, a router is middleware itself:
 * `router(req, res, next)` runs it like `router.handle(req, res, next)`.
 */
export interface PypeRouter extends ExtraRouteMethods<PypeRouter> {
  (req: IncomingMessage, res: ServerResponse, next?: (err?: any) => void): void;
}

/** Runs a router called as a function; set by the app module, which has the pipeline. */
let runRouter: ((router: PypeRouter, req: IncomingMessage, res: ServerResponse, next?: (err?: any) => void) => void) | undefined;

/** Sets how routers called as functions run, see {@link PypeRouter.handle}. */
export function setRouterRunner(runner: typeof runRouter) {
  runRouter = runner;
}

/**
 * Express-style router: middleware, routes and sub-routers run in the order
 * they are registered.
 */
export class PypeRouter {
  private readonly stack: StackEntry[] = [];

  /** Whether `req.params` keeps the params of this router's mount paths, see {@link RouterOptions.mergeParams}. */
  readonly mergeParams: boolean;
  /** See {@link RouterOptions.caseSensitive}; `undefined` follows the app. */
  readonly caseSensitive?: boolean;
  /** See {@link RouterOptions.strict}; `undefined` follows the app. */
  readonly strict?: boolean;

  /**
   * @param options - Router options, see {@link RouterOptions}.
   */
  constructor(options: RouterOptions = {}) {
    this.mergeParams = Boolean(options.mergeParams);
    if (options.caseSensitive !== undefined) this.caseSensitive = Boolean(options.caseSensitive);
    if (options.strict !== undefined) this.strict = Boolean(options.strict);

    // The router is a function, like Express's: it gets this object's
    // fields and prototype, and the constructor returns it instead.
    const router = function (req: IncomingMessage, res: ServerResponse, next?: (err?: any) => void) {
      router.handle(req, res, next);
    } as PypeRouter;
    Object.setPrototypeOf(router, new.target.prototype);
    Object.assign(router, this);
    return router;
  }

  /**
   * Runs a request through this router on its own, like Express's
   * `router.handle()`: as middleware or a route handler (`app.get(path,
   * router)`), or called directly. Without a `next`, what the router
   * doesn't handle gets a 404. `req.app` stays the app it is in; with
   * `mergeParams`, the router keeps the `req.params` it was called with.
   */
  handle(req: IncomingMessage, res: ServerResponse, next?: (err?: any) => void) {
    runRouter!(this, req, res, next);
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
  use(path: PathParam, ...handlers: Array<Middleware | Middleware[]>): this;
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

    // Express's messages, which code and tests written for it check.
    if (handlers.length === 0) throw new TypeError("argument handler is required");

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
        throw new TypeError("argument handler must be a function");
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
    return this.addRoute(path, undefined, handlers);
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
    return this.addRoute(path, HTTP_METHODS.GET, handlers);
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
    return this.addRoute(path, HTTP_METHODS.POST, handlers);
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
    return this.addRoute(path, HTTP_METHODS.PUT, handlers);
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
    return this.addRoute(path, HTTP_METHODS.DELETE, handlers);
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
    return this.addRoute(path, HTTP_METHODS.PATCH, handlers);
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
    return this.addRoute(path, HTTP_METHODS.HEAD, handlers);
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
    return this.addRoute(path, HTTP_METHODS.OPTIONS, handlers);
  }

  /**
   * Starts a chainable route definition for one path.
   *
   * @example router.route("/users").get(list).post(create)
   */
  route(path: PathParam): Route {
    const route = new Route(path);
    this.stack.push({ type: "route", path, route });
    version++;
    return route;
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
      // Each middleware is a layer of its own in Express, with its own group.
      const groups = entry.type === "use" ? entry.handlers.map(() => (paths.length > 1 ? {} : undefined)) : [];

      if (entry.type === "router") {
        // Each mount path gets its own copy of the router's layers; copy i of
        // every layer shares a group, so only the first matching mount runs it.
        const copies = paths.map((path) => {
          const full = joinPaths(basePath, path as string);
          const scopes = [...mounts, { router: this, keys: paramKeys(path as string), path: full }];
          return [
            ...entry.router.compile(full, chain, scopes),
            { kind: "end", router: entry.router, routers: [...chain, entry.router], path: full, mounts: scopes } as RouterEndLayer,
          ];
        });
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
          entry.handlers.forEach((handle, i) => {
            layers.push({
              kind: "middleware",
              path: mount,
              pattern,
              pathPattern,
              ownPath: typeof path === "string" ? path : undefined,
              base: trimSlashes(basePath),
              handle,
              routers: chain,
              keys,
              mounts,
              group: groups[i],
            });
          });
        } else {
          layers.push({
            kind: "route",
            fullPath: below ? trimSlashes(basePath) : joinPaths(basePath, path as string),
            routePath: entry.path,
            pattern: path instanceof RegExp ? statelessPattern(path) : undefined,
            pathPattern,
            ownPath: typeof path === "string" ? path : undefined,
            baseUrl: trimSlashes(basePath),
            methods: routeMethods(entry.route),
            route: entry.route,
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
  private addRoute(path: PathParam, method: string | undefined, handlers: HandlerParam[]) {
    // Like Express, each one is a route of its own; checked before it is registered.
    const route = new Route(path);
    if (method) (route as any).add(method, handlers);
    else route.all(...handlers);
    this.stack.push({ type: "route", path, route });
    version++;
    return this;
  }}

// Every other HTTP method gets a route method too, like in Express.
for (const method of METHODS) {
  if (Object.prototype.hasOwnProperty.call(PypeRouter.prototype, method)) continue;
  Object.defineProperty(PypeRouter.prototype, method, {
    configurable: true,
    writable: true,
    value(this: PypeRouter, path: PathParam, ...handlers: HandlerParam[]) {
      return (this as any).addRoute(path, method, handlers);
    },
  });
  Object.defineProperty(Route.prototype, method, {
    configurable: true,
    writable: true,
    value(this: Route, ...handlers: HandlerParam[]) {
      return (this as any).add(method, handlers);
    },
  });
}

/**
 * Whether the first `use()` argument is a mount path rather than a handler,
 * the test Express uses: anything whose first leaf (in nested arrays) isn't
 * a function or router, so `use(3)` is a path without handlers.
 */
export function isPathArgument(arg: unknown): boolean {
  let first = arg;
  while (Array.isArray(first) && first.length > 0) first = first[0];
  return typeof first !== "function" && !(first instanceof PypeRouter);
}

/** The methods a route registers for in the tree; `METHODS` itself for `all()`. */
function routeMethods(route: Route): string[] {
  if (route.methods._all) return METHODS;
  return Object.keys(route.methods);
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
