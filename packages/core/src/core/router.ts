import { HTTP_METHODS } from "../enums/methods.enum";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";

/** Anything `app.use()` and `router.use()` accept, arrays are flattened like Express. */
export type UseHandler = Middleware | ErrorMiddleware | AnyHandler | PypeRouter | UseHandler[];

/** A route handler or a (nested) array of them. */
export type HandlerParam = RouteHandler | AnyHandler | HandlerParam[];

/** Every supported HTTP method, used by `all()`. */
const ALL_METHODS = Object.values(HTTP_METHODS);

/** Bumped on every registration so apps know to rebuild their routing table. */
let version = 0;

/** Current registration counter, compared by apps to detect changes. */
export const routingVersion = () => version;

/** Something registered on a router, in registration order. */
type StackEntry =
  | { type: "use"; path: string; handlers: AnyHandler[] }
  | { type: "router"; path: string; router: PypeRouter }
  | { type: "route"; path: string; methods: HTTP_METHODS[]; handlers: AnyHandler[] };

/** A middleware function with its resolved mount path. */
export interface MiddlewareLayer {
  kind: "middleware";
  /** Full mount path, the middleware runs for this path and below it. */
  path: string;
  /** The middleware or error middleware. */
  handle: AnyHandler;
  /** Routers this layer belongs to, outermost first. */
  routers: PypeRouter[];
}

/** A route with its resolved paths. */
export interface RouteLayer {
  kind: "route";
  /** Path including every mount prefix, used for matching. */
  fullPath: string;
  /** Path as written in the route definition, exposed as `req.route.path`. */
  routePath: string;
  /** Mount path of the route's router, exposed as `req.baseUrl`. */
  baseUrl: string;
  /** HTTP methods the route responds to. */
  methods: HTTP_METHODS[];
  /** Handlers, run in order. */
  handlers: AnyHandler[];
  /** Routers this layer belongs to, outermost first. */
  routers: PypeRouter[];
}

/** One step of the request pipeline. */
export type Layer = MiddlewareLayer | RouteLayer;

/** Chainable route definition returned by {@link PypeRouter.route}. */
export class RouteBuilder {
  /**
   * @param path - Path every route in the chain is registered on.
   * @param router - Router the routes are added to.
   */
  constructor(
    private path: string,
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

/**
 * Express-style router: middleware, routes and sub-routers run in the order
 * they are registered.
 */
export class PypeRouter {
  private readonly stack: StackEntry[] = [];

  /**
   * Adds middleware, error middleware or sub-routers. With a path, they only
   * run for that path and below it, and see `req.url`, `req.path` and
   * `req.baseUrl` relative to it.
   *
   * @param path - Optional mount path, defaults to `/`.
   * @param handlers - Middleware functions, routers, or arrays of them.
   * @throws When no handler is given or a handler isn't a function or router.
   */
  use(...handlers: Array<Middleware | Middleware[]>): this;
  use(path: string, ...handlers: Array<Middleware | Middleware[] | PypeRouter>): this;
  use(...handlers: ErrorMiddleware[]): this;
  use(path: string, ...handlers: ErrorMiddleware[]): this;
  use(...handlers: UseHandler[]): this;
  use(path: string, ...handlers: UseHandler[]): this;
  use(...args: Array<string | UseHandler>): this {
    const path = typeof args[0] === "string" ? (args.shift() as string) : "/";
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
  all(path: string, ...handlers: RouteHandler[]): this;
  all(path: string, ...handlers: HandlerParam[]): this;
  all(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, ALL_METHODS, handlers);
  }

  /**
   * Adds a GET route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  get(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  get(path: string, ...handlers: HandlerParam[]): this;
  get(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.GET], handlers);
  }

  /**
   * Adds a POST route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  post(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  post(path: string, ...handlers: HandlerParam[]): this;
  post(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.POST], handlers);
  }

  /**
   * Adds a PUT route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  put(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  put(path: string, ...handlers: HandlerParam[]): this;
  put(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.PUT], handlers);
  }

  /**
   * Adds a DELETE route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  delete(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  delete(path: string, ...handlers: HandlerParam[]): this;
  delete(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.DELETE], handlers);
  }

  /**
   * Adds a PATCH route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  patch(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  patch(path: string, ...handlers: HandlerParam[]): this;
  patch(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.PATCH], handlers);
  }

  /**
   * Adds a HEAD route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  head(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  head(path: string, ...handlers: HandlerParam[]): this;
  head(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.HEAD], handlers);
  }

  /**
   * Adds a OPTIONS route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  options(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  options(path: string, ...handlers: HandlerParam[]): this;
  options(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.OPTIONS], handlers);
  }

  /**
   * Starts a chainable route definition for one path.
   *
   * @example router.route("/users").get(list).post(create)
   */
  route(path: string) {
    return new RouteBuilder(path, this);
  }

  /**
   * Flattens this router and its sub-routers into layers, in registration
   * order, with mount paths resolved.
   *
   * @param basePath - Mount path of this router.
   * @param routers - Routers this one is nested in, outermost first.
   */
  compile(basePath = "", routers: PypeRouter[] = []): Layer[] {
    const chain = [...routers, this];
    const layers: Layer[] = [];

    for (const entry of this.stack) {
      const path = joinPaths(basePath, entry.path);

      if (entry.type === "use") {
        for (const handle of entry.handlers) {
          layers.push({ kind: "middleware", path, handle, routers: chain });
        }
      } else if (entry.type === "router") {
        layers.push(...entry.router.compile(path, chain));
      } else {
        layers.push({
          kind: "route",
          fullPath: path,
          routePath: entry.path,
          baseUrl: trimSlashes(basePath),
          methods: entry.methods,
          handlers: [...entry.handlers],
          routers: chain,
        });
      }
    }

    return layers;
  }

  /**
   * Records a route on the stack.
   *
   * @throws When no handlers are given or one isn't a function.
   */
  private addRoute(path: string, methods: HTTP_METHODS[], handlers: HandlerParam[]) {
    const flat = (handlers as unknown[]).flat(Infinity) as AnyHandler[];

    if (flat.length === 0 || flat.some((h) => typeof h !== "function")) {
      throw new TypeError(`Route ${path} requires handler functions`);
    }

    this.stack.push({ type: "route", path, methods, handlers: flat });
    version++;
    return this;
  }
}

/** Collapses repeated slashes and drops trailing ones. */
function trimSlashes(path: string) {
  return path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** Joins a mount path and a child path: `/api` + `users` is `/api/users`. */
function joinPaths(base: string, path: string) {
  return trimSlashes(base) + (path.startsWith("/") ? path : `/${path}`);
}
