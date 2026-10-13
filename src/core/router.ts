import { HTTP_METHODS } from "../enums/methods.enum";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";

// Anything app.use() / router.use() accepts, arrays are flattened like Express.
export type UseHandler = Middleware | ErrorMiddleware | AnyHandler | PypeRouter | UseHandler[];
export type HandlerParam = RouteHandler | AnyHandler | HandlerParam[];

const ALL_METHODS = Object.values(HTTP_METHODS);

// Bumped on every registration so apps know to rebuild their routing table.
let version = 0;
export const routingVersion = () => version;

type StackEntry =
  | { type: "use"; path: string; handlers: AnyHandler[] }
  | { type: "router"; path: string; router: PypeRouter }
  | { type: "route"; path: string; methods: HTTP_METHODS[]; handlers: AnyHandler[] };

export interface MiddlewareLayer {
  kind: "middleware";
  path: string;
  handle: AnyHandler;
  routers: PypeRouter[];
}

export interface RouteLayer {
  kind: "route";
  fullPath: string;
  routePath: string;
  baseUrl: string;
  methods: HTTP_METHODS[];
  handlers: AnyHandler[];
  routers: PypeRouter[];
}

export type Layer = MiddlewareLayer | RouteLayer;

class RouteBuilder {
  constructor(
    private path: string,
    private router: PypeRouter,
  ) {}

  all(...handlers: HandlerParam[]): this {
    this.router.all(this.path, ...handlers);
    return this;
  }

  get(...handlers: HandlerParam[]): this {
    this.router.get(this.path, ...handlers);
    return this;
  }

  post(...handlers: HandlerParam[]): this {
    this.router.post(this.path, ...handlers);
    return this;
  }

  put(...handlers: HandlerParam[]): this {
    this.router.put(this.path, ...handlers);
    return this;
  }

  delete(...handlers: HandlerParam[]): this {
    this.router.delete(this.path, ...handlers);
    return this;
  }

  patch(...handlers: HandlerParam[]): this {
    this.router.patch(this.path, ...handlers);
    return this;
  }

  head(...handlers: HandlerParam[]): this {
    this.router.head(this.path, ...handlers);
    return this;
  }

  options(...handlers: HandlerParam[]): this {
    this.router.options(this.path, ...handlers);
    return this;
  }
}

export class PypeRouter {
  private readonly stack: StackEntry[] = [];

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

  all(path: string, ...handlers: RouteHandler[]): this;
  all(path: string, ...handlers: HandlerParam[]): this;
  all(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, ALL_METHODS, handlers);
  }

  get(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  get(path: string, ...handlers: HandlerParam[]): this;
  get(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.GET], handlers);
  }

  post(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  post(path: string, ...handlers: HandlerParam[]): this;
  post(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.POST], handlers);
  }

  put(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  put(path: string, ...handlers: HandlerParam[]): this;
  put(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.PUT], handlers);
  }

  delete(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  delete(path: string, ...handlers: HandlerParam[]): this;
  delete(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.DELETE], handlers);
  }

  patch(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  patch(path: string, ...handlers: HandlerParam[]): this;
  patch(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.PATCH], handlers);
  }

  head(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  head(path: string, ...handlers: HandlerParam[]): this;
  head(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.HEAD], handlers);
  }

  options(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  options(path: string, ...handlers: HandlerParam[]): this;
  options(path: string, ...handlers: HandlerParam[]): this {
    return this.addRoute(path, [HTTP_METHODS.OPTIONS], handlers);
  }

  route(path: string) {
    return new RouteBuilder(path, this);
  }

  // Flattens this router and its sub-routers into layers, in registration
  // order, with mount paths resolved.
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
          // a fresh array per compile identifies the layer in the trie
          handlers: [...entry.handlers],
          routers: chain,
        });
      }
    }

    return layers;
  }

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

function trimSlashes(path: string) {
  return path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function joinPaths(base: string, path: string) {
  return trimSlashes(base) + (path.startsWith("/") ? path : `/${path}`);
}
