import {
  IncomingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  createServer,
} from "http";
import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { RouteNode } from "../utils/Trie-Route";
import {
  HandlerParam,
  Layer,
  MiddlewareLayer,
  PypeRouter,
  RouteLayer,
  UseHandler,
  routingVersion,
} from "./router";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { Request } from "./request";
import { Response } from "./response";
import { parseQuery } from "../utils/helpers";
import { compileTrust } from "../utils/trust-proxy";

/** App settings, keyed by Express setting names such as `"trust proxy"`. */
type Settings = Record<string, any>;

/**
 * An Express-compatible application.
 *
 * @example
 * const app = new Pype();
 * app.use(json());
 * app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
 * app.listen(3000);
 */
export class Pype {
  /** Express-compatible settings, e.g. `app.set("trust proxy", "loopback")`. */
  settings: Settings = {};
  /** Values shared by the whole app, like Express's `app.locals`. */
  locals: Record<string, any> = {};

  private readonly router = new PypeRouter();
  private layers: Layer[] = [];
  private routes = createRouteTable();
  /** Trie entry to every route layer registered for that method and path. */
  private routeLayers = new Map<AnyHandler[], RouteLayer[]>();
  private compiledVersion = -1;

  /**
   * @param settings - Initial settings, applied with {@link Pype.set}.
   */
  constructor(settings: Settings = {}) {
    this.set("env", process.env.NODE_ENV || "development");
    this.set("etag", true);
    this.set("trust proxy", false);
    this.set("subdomain offset", 2);
    this.set("json spaces", undefined);
    this.set("json replacer", undefined);

    for (const name in settings) this.set(name, settings[name]);
  }

  /**
   * Sets a setting. `"trust proxy"` accepts the same values as Express.
   *
   * @param name - Setting name, e.g. `"etag"` or `"json spaces"`.
   * @param value - New value.
   */
  set(name: string, value: any): this {
    this.settings[name] = value;
    if (name === "trust proxy")
      this.settings["trust proxy fn"] = compileTrust(value);
    return this;
  }

  /** Sets a setting to `true`. */
  enable(name: string): this {
    return this.set(name, true);
  }

  /** Sets a setting to `false`. */
  disable(name: string): this {
    return this.set(name, false);
  }

  /** Whether a setting is truthy. */
  enabled(name: string): boolean {
    return Boolean(this.settings[name]);
  }

  /** Whether a setting is falsy. */
  disabled(name: string): boolean {
    return !this.settings[name];
  }

  /**
   * Starts an HTTP server that uses Pype's request and response classes.
   * Route conflicts are reported here, before the first request arrives.
   *
   * @param port - Port to listen on, `0` picks a free one.
   * @param hostname - Interface to bind, e.g. `"127.0.0.1"` behind a proxy.
   * @param callback - Called once the server is listening.
   * @returns The underlying `http.Server`, e.g. for graceful shutdown.
   * @throws When routes conflict, e.g. different param names at one position.
   */
  listen(port: number, callback?: () => void): Server;
  listen(port: number, hostname: string, callback?: () => void): Server;
  listen(
    port: number,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): Server {
    this.compile();

    const server = createServer(
      { IncomingMessage: Request, ServerResponse: Response },
      this.handler,
    );

    if (typeof hostnameOrCallback === "string") {
      return server.listen(port, hostnameOrCallback, callback);
    }
    return server.listen(port, hostnameOrCallback);
  }

  /** Request listener for `http.createServer(app.handler)`, supertest, etc. */
  handler = (req: IncomingMessage, res: ServerResponse) => {
    this.handle(req, res);
  };

  /**
   * Adds middleware, error middleware or routers. With a path, they only run
   * for that path and below it, and see `req.url`, `req.path` and
   * `req.baseUrl` relative to it.
   *
   * @param path - Optional mount path, defaults to `/`.
   * @param handlers - Middleware functions, routers, or arrays of them.
   */
  use(...handlers: Array<Middleware | Middleware[]>): this;
  use(
    path: string,
    ...handlers: Array<Middleware | Middleware[] | PypeRouter>
  ): this;
  use(...handlers: ErrorMiddleware[]): this;
  use(path: string, ...handlers: ErrorMiddleware[]): this;
  use(...handlers: UseHandler[]): this;
  use(path: string, ...handlers: UseHandler[]): this;
  use(...args: any[]): this {
    (this.router.use as (...args: any[]) => PypeRouter)(...args);
    return this;
  }

  /**
   * With one argument, reads a setting. Otherwise adds a GET route.
   *
   * @param path - Setting name, or route path such as `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  get(setting: string): any;
  get(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  get(path: string, ...handlers: HandlerParam[]): this;
  get(path: string, ...handlers: HandlerParam[]): any {
    if (handlers.length === 0) return this.settings[path];
    this.router.get(path, ...handlers);
    return this;
  }

  /**
   * Adds a route for every HTTP method.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  all(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  all(path: string, ...handlers: HandlerParam[]): this;
  all(path: string, ...handlers: HandlerParam[]): this {
    this.router.all(path, ...handlers);
    return this;
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
    this.router.post(path, ...handlers);
    return this;
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
    this.router.put(path, ...handlers);
    return this;
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
    this.router.patch(path, ...handlers);
    return this;
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
    this.router.delete(path, ...handlers);
    return this;
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
    this.router.head(path, ...handlers);
    return this;
  }

  /**
   * Adds an OPTIONS route.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  options(
    path: string,
    ...handlers: Array<RouteHandler | RouteHandler[]>
  ): this;
  options(path: string, ...handlers: HandlerParam[]): this;
  options(path: string, ...handlers: HandlerParam[]): this {
    this.router.options(path, ...handlers);
    return this;
  }

  /**
   * Starts a chainable route definition for one path.
   *
   * @example app.route("/users").get(list).post(create)
   */
  route(path: string) {
    return this.router.route(path);
  }

  /**
   * Rebuilds the layer list and route trie when routes or middleware changed.
   * Express allows several routes with the same method and path, they share
   * one trie entry and run in registration order.
   */
  private compile() {
    if (this.compiledVersion === routingVersion()) return;

    const layers = this.router.compile();
    const routes = createRouteTable();
    const routeLayers = new Map<AnyHandler[], RouteLayer[]>();
    const entries = new Map<string, AnyHandler[]>();

    for (const layer of layers) {
      if (layer.kind !== "route") continue;

      for (const method of layer.methods) {
        const key = `${method} ${normalizeBase(layer.fullPath) || "/"}`;
        const existing = entries.get(key);

        if (existing) {
          routeLayers.get(existing)!.push(layer);
          continue;
        }

        const entry: AnyHandler[] = [];
        entries.set(key, entry);
        routeLayers.set(entry, [layer]);
        routes.register(layer.fullPath, method, entry as RouteHandler[], {
          path: layer.routePath,
          baseUrl: layer.baseUrl,
        });
      }
    }

    this.layers = layers;
    this.routes = routes;
    this.routeLayers = routeLayers;
    this.compiledVersion = routingVersion();
  }

  /**
   * Runs a request through the layers in registration order. HEAD requests
   * fall back to GET routes, Node drops the body. `next("router")` skips the
   * remaining layers of the innermost router of the layer that called it.
   */
  private handle(rawReq: IncomingMessage, rawRes: ServerResponse) {
    const { req, res } = this.prepare(rawReq, rawRes);

    try {
      this.compile();
    } catch (error) {
      return this.finalHandler(req, res, error);
    }

    const method = (req.method || "GET").toLowerCase() as HTTP_METHODS;

    const match =
      this.routes.match(req.path, method) ??
      (method === HTTP_METHODS.HEAD
        ? this.routes.match(req.path, HTTP_METHODS.GET)
        : null);

    const matchedLayers = new Set(
      match ? this.routeLayers.get(match.handlers) : [],
    );
    const layers = this.layers;
    let index = 0;
    let current: Layer | undefined;

    const next = (err?: any) => {
      if (err === "route") err = undefined;

      if (err === "router") {
        const router = current?.routers[current.routers.length - 1];
        while (
          router &&
          index < layers.length &&
          layers[index].routers.includes(router)
        ) {
          index++;
        }
        err = undefined;
      }

      while (index < layers.length) {
        const layer = layers[index++];

        if (layer.kind === "route") {
          if (!matchedLayers.has(layer)) continue;
          current = layer;
          return this.runRoute(req, res, layer, match!.params, method, err, next);
        }

        if (!matchesPrefix(req.path, layer.path)) continue;

        const isErrorHandler = layer.handle.length === 4;
        if (Boolean(err) !== isErrorHandler) continue;

        current = layer;
        return this.callMiddleware(req, res, layer, err, next);
      }

      this.finalHandler(req, res, err);
    };

    req.next = next;
    next();
  }

  /**
   * Gives requests from `http.createServer(app.handler)` the Pype prototypes
   * and resets per-request state, like Express does.
   *
   * Duplicate slashes are collapsed in `req.path` and `req.url` here, once,
   * so path-scoped middleware sees the same path the router matches.
   * Otherwise `//admin/secret` could reach an `/admin/secret` route without
   * running middleware mounted on `/admin`. `req.originalUrl` keeps the raw URL.
   */
  private prepare(rawReq: IncomingMessage, rawRes: ServerResponse) {
    if (!(rawReq instanceof Request))
      Object.setPrototypeOf(rawReq, Request.prototype);
    if (!(rawRes instanceof Response))
      Object.setPrototypeOf(rawRes, Response.prototype);

    const req = rawReq as Request;
    const res = rawRes as Response;
    const url = req.url || "/";
    const queryStart = url.indexOf("?");
    const rawPath = queryStart === -1 ? url : url.slice(0, queryStart);
    const path = rawPath.includes("//") ? rawPath.replace(/\/{2,}/g, "/") : rawPath;

    req.app = this;
    res.app = this;
    req.res = res;
    req.originalUrl = url;
    req.path = path;
    req.url = path === rawPath ? url : path + url.slice(rawPath.length);
    req.query =
      queryStart === -1 ? Object.create(null) : parseQuery(url.slice(queryStart + 1));
    req.baseUrl = "";
    req.params = {};
    res.locals = res.locals || {};

    return { req, res };
  }

  /**
   * Calls a middleware layer. Like Express, the middleware sees `req.url` and
   * `req.path` relative to its mount path, they are restored when it calls
   * `next()`.
   */
  private callMiddleware(
    req: Request,
    res: Response,
    layer: MiddlewareLayer,
    err: any,
    next: (err?: any) => void,
  ) {
    const { url, path, baseUrl } = req;
    mount(req, layer.path);

    const done = once((error?: any) => {
      req.url = url;
      req.path = path;
      req.baseUrl = baseUrl;
      next(error);
    });

    invoke(layer.handle, err, req, res, done);
  }

  /**
   * Runs a route's handlers in order. While an error is pending only
   * four-argument handlers run; `next("route")` leaves the route early.
   */
  private runRoute(
    req: Request,
    res: Response,
    layer: RouteLayer,
    params: Record<string, string>,
    method: string,
    err: any,
    next: (err?: any) => void,
  ) {
    const { url, path, baseUrl } = req;
    req.params = params;
    req.route = { path: layer.routePath, method };
    mount(req, layer.baseUrl);

    const leave = (error?: any) => {
      req.url = url;
      req.path = path;
      req.baseUrl = baseUrl;
      next(error);
    };

    let index = 0;
    const routeNext = (error?: any) => {
      if (error === "route" || error === "router") return leave(error);

      while (index < layer.handlers.length) {
        const handler = layer.handlers[index++];
        if (Boolean(error) !== (handler.length === 4)) continue;
        return invoke(handler, error, req, res, once(routeNext));
      }

      leave(error);
    };

    routeNext(err);
  }

  /**
   * Runs when nothing handled the request, like Express's `finalhandler`:
   * responds 404, or with the error's status, and only exposes the message
   * of 4xx errors.
   */
  private finalHandler(req: Request, res: Response, err?: any) {
    if (!err && res.headersSent) return;

    let status = 404;
    let message = `Cannot ${req.method} ${req.originalUrl.split("?")[0]}`;

    if (err) {
      status = errorStatus(err);
      message = STATUS_CODES[status] || "Internal Server Error";

      if (status < 500 && err.expose !== false && err.message) {
        message = err.message;
      }

      if (this.get("env") !== "test") console.error(err);
    }

    if (res.headersSent) {
      req.socket?.destroy();
      return;
    }

    for (const name of res.getHeaderNames()) res.removeHeader(name);
    if (err?.headers) res.set(err.headers);

    res.status(status).json({ error: message, status });
  }
}

/** Creates the route trie with Express's slash handling. */
function createRouteTable() {
  return new RouteNode({
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
  });
}

/**
 * Calls a handler (or error handler), routing throws and rejected promises
 * to `next(err)` like Express 5.
 */
function invoke(
  handler: AnyHandler,
  err: any,
  req: Request,
  res: Response,
  next: (err?: any) => void,
) {
  try {
    const result: any = err
      ? handler(err, req, res, next)
      : handler(req, res, next);

    if (result && typeof result.then === "function") {
      result.then(undefined, (error: unknown) =>
        next(error ?? new Error("Rejected promise")),
      );
    }
  } catch (error) {
    next(error);
  }
}

/** Wraps `next` so calling it again only logs a warning. */
function once(fn: (err?: any) => void) {
  let called = false;
  return (err?: any) => {
    if (called) {
      console.warn("[warn]: next() called multiple times");
      return;
    }
    called = true;
    fn(err);
  };
}

/** HTTP status of an error, from `status` or `statusCode`, 500 otherwise. */
function errorStatus(err: any): number {
  const status = err?.status ?? err?.statusCode;
  return typeof status === "number" && status >= 400 && status < 600
    ? status
    : 500;
}

/** Collapses repeated slashes and drops trailing ones. */
function normalizeBase(base: string) {
  return base.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** `/some` matches `/some` and `/some/...`, but not `/something`. */
function matchesPrefix(requestPath: string, prefix: string) {
  const base = normalizeBase(prefix);
  if (base === "") return true;
  return requestPath === base || requestPath.startsWith(base + "/");
}

/** Strips `base` from the front of `req.url` and `req.path` and appends it to `req.baseUrl`. */
function mount(req: Request, base: string) {
  const prefix = normalizeBase(base);
  if (!prefix) return;

  req.baseUrl = normalizeBase(req.baseUrl + prefix);
  req.path = req.path.slice(prefix.length) || "/";

  const url = req.url || "/";
  const rest = url.slice(prefix.length);
  req.url = rest.startsWith("?") || rest === "" ? `/${rest}` : rest;
}
