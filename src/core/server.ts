import {
  IncomingMessage,
  STATUS_CODES,
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

type Settings = Record<string, any>;

export class Pype {
  // Express-compatible settings, e.g. app.set("trust proxy", "loopback").
  settings: Settings = {};
  locals: Record<string, any> = {};

  private readonly router = new PypeRouter();
  private layers: Layer[] = [];
  private routes = createRouteTable();
  // trie entry -> every route layer registered for that method and path
  private routeLayers = new Map<AnyHandler[], RouteLayer[]>();
  private compiledVersion = -1;

  constructor(settings: Settings = {}) {
    this.set("env", process.env.NODE_ENV || "development");
    this.set("etag", true);
    this.set("trust proxy", false);
    this.set("subdomain offset", 2);
    this.set("json spaces", undefined);
    this.set("json replacer", undefined);

    for (const name in settings) this.set(name, settings[name]);
  }

  set(name: string, value: any): this {
    this.settings[name] = value;
    if (name === "trust proxy")
      this.settings["trust proxy fn"] = compileTrust(value);
    return this;
  }

  enable(name: string): this {
    return this.set(name, true);
  }

  disable(name: string): this {
    return this.set(name, false);
  }

  enabled(name: string): boolean {
    return Boolean(this.settings[name]);
  }

  disabled(name: string): boolean {
    return !this.settings[name];
  }

  listen(port: number, callback?: () => void) {
    this.compile();

    const server = createServer(
      { IncomingMessage: Request, ServerResponse: Response },
      this.handler,
    );
    return server.listen(port, callback);
  }

  // Request listener for http.createServer(app.handler), supertest, etc.
  handler = (req: IncomingMessage, res: ServerResponse) => {
    this.handle(req, res);
  };

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

  // app.get("setting") reads a setting, app.get(path, ...handlers) adds a route.
  get(setting: string): any;
  get(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  get(path: string, ...handlers: HandlerParam[]): this;
  get(path: string, ...handlers: HandlerParam[]): any {
    if (handlers.length === 0) return this.settings[path];
    this.router.get(path, ...handlers);
    return this;
  }

  all(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  all(path: string, ...handlers: HandlerParam[]): this;
  all(path: string, ...handlers: HandlerParam[]): this {
    this.router.all(path, ...handlers);
    return this;
  }

  post(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  post(path: string, ...handlers: HandlerParam[]): this;
  post(path: string, ...handlers: HandlerParam[]): this {
    this.router.post(path, ...handlers);
    return this;
  }

  put(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  put(path: string, ...handlers: HandlerParam[]): this;
  put(path: string, ...handlers: HandlerParam[]): this {
    this.router.put(path, ...handlers);
    return this;
  }

  patch(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  patch(path: string, ...handlers: HandlerParam[]): this;
  patch(path: string, ...handlers: HandlerParam[]): this {
    this.router.patch(path, ...handlers);
    return this;
  }

  delete(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  delete(path: string, ...handlers: HandlerParam[]): this;
  delete(path: string, ...handlers: HandlerParam[]): this {
    this.router.delete(path, ...handlers);
    return this;
  }

  head(path: string, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  head(path: string, ...handlers: HandlerParam[]): this;
  head(path: string, ...handlers: HandlerParam[]): this {
    this.router.head(path, ...handlers);
    return this;
  }

  options(
    path: string,
    ...handlers: Array<RouteHandler | RouteHandler[]>
  ): this;
  options(path: string, ...handlers: HandlerParam[]): this;
  options(path: string, ...handlers: HandlerParam[]): this {
    this.router.options(path, ...handlers);
    return this;
  }

  route(path: string) {
    return this.router.route(path);
  }

  // Rebuilds the layer list and route trie when routes or middleware changed.
  private compile() {
    if (this.compiledVersion === routingVersion()) return;

    const layers = this.router.compile();
    const routes = createRouteTable();
    const routeLayers = new Map<AnyHandler[], RouteLayer[]>();
    const entries = new Map<string, AnyHandler[]>();

    for (const layer of layers) {
      if (layer.kind !== "route") continue;

      for (const method of layer.methods) {
        // Express allows several routes with the same method and path, they
        // share one trie entry and run in registration order.
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

  private handle(rawReq: IncomingMessage, rawRes: ServerResponse) {
    const { req, res } = this.prepare(rawReq, rawRes);

    try {
      this.compile();
    } catch (error) {
      return this.finalHandler(req, res, error);
    }

    const method = (req.method || "GET").toLowerCase() as HTTP_METHODS;

    // HEAD requests fall back to GET handlers; Node drops the body.
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
        // leave the innermost router of the layer that called next("router")
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

  // Gives requests from http.createServer(app.handler) the Pype prototypes
  // and resets per-request state, like Express does.
  private prepare(rawReq: IncomingMessage, rawRes: ServerResponse) {
    if (!(rawReq instanceof Request))
      Object.setPrototypeOf(rawReq, Request.prototype);
    if (!(rawRes instanceof Response))
      Object.setPrototypeOf(rawRes, Response.prototype);

    const req = rawReq as Request;
    const res = rawRes as Response;
    const url = req.url || "/";
    const queryStart = url.indexOf("?");

    req.app = this;
    res.app = this;
    req.res = res;
    req.originalUrl = url;
    req.path = queryStart === -1 ? url : url.slice(0, queryStart);
    req.query = queryStart === -1 ? {} : parseQuery(url.slice(queryStart + 1));
    req.baseUrl = "";
    req.params = {};
    res.locals = res.locals || {};

    return { req, res };
  }

  private callMiddleware(
    req: Request,
    res: Response,
    layer: MiddlewareLayer,
    err: any,
    next: (err?: any) => void,
  ) {
    // Like Express, the middleware sees req.url/req.path relative to its
    // mount path; they are restored when it calls next().
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

  // Runs when nothing handled the request, like Express's finalhandler.
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

function createRouteTable() {
  return new RouteNode({
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
  });
}

// Calls a handler (or error handler), routing throws and rejected promises
// to next(err) like Express 5.
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

function errorStatus(err: any): number {
  const status = err?.status ?? err?.statusCode;
  return typeof status === "number" && status >= 400 && status < 600
    ? status
    : 500;
}

function normalizeBase(base: string) {
  return base.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

// "/some" matches "/some" and "/some/...", but not "/something".
function matchesPrefix(requestPath: string, prefix: string) {
  const base = normalizeBase(prefix);
  if (base === "") return true;
  return requestPath === base || requestPath.startsWith(base + "/");
}

// Strips `base` from the front of req.url / req.path and appends it to
// req.baseUrl.
function mount(req: Request, base: string) {
  const prefix = normalizeBase(base);
  if (!prefix) return;

  req.baseUrl = normalizeBase(req.baseUrl + prefix);
  req.path = req.path.slice(prefix.length) || "/";

  const url = req.url || "/";
  const rest = url.slice(prefix.length);
  req.url = rest.startsWith("?") || rest === "" ? `/${rest}` : rest;
}
