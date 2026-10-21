import {
  IncomingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  createServer,
} from "http";
import { EventEmitter } from "events";
import { HTTP_METHODS, METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { lowerAscii, RouteNode } from "../utils/Trie-Route";
import {
  ExtraRouteMethods,
  HandlerParam,
  Layer,
  MiddlewareLayer,
  ParamHandler,
  PathParam,
  PypeRouter,
  RouteLayer,
  UseHandler,
  isPathArgument,
  routingVersion,
  setRouterRunner,
} from "./router";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { NextFunction } from "../types/next-function";
import { invoke, once } from "./invoke";
import { Request } from "./request";
import { Response } from "./response";
import { generateETag, generateStrongETag, parseQuery } from "../utils/helpers";
import { parseQs } from "../utils/qs";
import { compileTrust } from "../utils/trust-proxy";
import { compilePathPattern, pathKeys } from "../utils/path-pattern";
import { resolve } from "path";
import { Engine, View } from "./view";

/** App settings, keyed by Express setting names such as `"trust proxy"`. */
type Settings = Record<string, any>;

/**
 * Like an Express app, a Pype app is a request listener itself:
 * `http.createServer(app)`, `https.createServer(options, app)` and
 * `supertest(app)` work.
 */
export interface Pype extends ExtraRouteMethods<Pype>, EventEmitter {
  /**
   * @param next - Called instead of answering when nothing handled the
   * request, or with an error, as when the app is mounted in another one.
   */
  (req: IncomingMessage, res: ServerResponse, next?: (err?: any) => void): void;
}

/**
 * Settings a mounted app takes from its parent unless it set them itself,
 * the ones Express doesn't give a default; `"trust proxy"` too, like Express.
 */
const INHERITED_SETTINGS = ["case sensitive routing", "strict routing", "json spaces", "json replacer", "trust proxy", "trust proxy fn"];

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
  // Like Express, these have no prototype: app.get("hasOwnProperty") is undefined.
  /** Express-compatible settings, e.g. `app.set("trust proxy", "loopback")`. */
  settings: Settings = Object.create(null);
  /** Values shared by the whole app and every view, like Express's `app.locals`. `locals.settings` is the app's settings. */
  locals: Record<string, any> = Object.create(null);
  /** Template engines by extension, see {@link Pype.engine}. */
  engines: Record<string, Engine> = Object.create(null);
  /** Views found so far by name, used when `"view cache"` is on. */
  cache: Record<string, View> = Object.create(null);
  /** The path this app is mounted on in its parent, like Express: `"/"` when it isn't mounted. */
  mountpath: PathParam = "/";
  /** The app this one is mounted in, see {@link Pype.use}. */
  parent?: Pype;
  /** The root router, like Express's `app.router`. */
  readonly router = new PypeRouter();
  /**
   * The prototype of this app's requests, like Express's `app.request`:
   * properties and methods added here are on every `req` of the app, and of
   * the apps mounted in it.
   */
  readonly request: Request;
  /** The prototype of this app's responses, like Express's `app.response`. */
  readonly response: Response;
  /** Classes whose prototypes are `request` and `response`, for the app's own server. */
  private requestClass: typeof Request;
  private responseClass: typeof Response;
  /** Settings that still have their default, which a mounted app may inherit instead. */
  private defaults = new Set<string>();
  /**
   * Runs a router called as a function, see {@link PypeRouter.handle}:
   * leaves `req.app`, `res.app` and `req.query` alone.
   */
  private hostsRouter = false;
  private layers: Layer[] = [];
  private routes = createRouteTable();
  /** Trie entry to every route layer registered for that method and path. */
  private routeLayers = new Map<AnyHandler[], RouteLayer[]>();
  /** Position of each layer in `layers`. */
  private layerIndex = new Map<Layer, number>();
  /**
   * Layers the tree can't rule out, in order: middleware, regular
   * expression routes and router ends. A request only walks these and the
   * route layers the tree matched.
   */
  private fixedLayers: Layer[] = [];
  private fixedIndices: number[] = [];
  private compiledVersion = -1;
  /** The `"case sensitive routing"` setting the routing table was built with. */
  private caseSensitive = true;
  /** The `"strict routing"` setting the routing table was built with. */
  private strict = false;
  /** Methods that have routes in the tree, the only ones worth looking up for another method. */
  private routedMethods: string[] = [];

  /**
   * @param settings - Initial settings, applied with {@link Pype.set}.
   */
  constructor(settings: Settings = {}) {
    this.requestClass = class extends Request {};
    this.responseClass = class extends Response {};
    this.request = this.requestClass.prototype;
    this.response = this.responseClass.prototype;

    this.set("env", process.env.NODE_ENV || "development");
    this.set("etag", "weak");
    // Unlike Express, no X-Powered-By header unless this is turned on.
    this.set("x-powered-by", false);
    this.set("trust proxy", false);
    this.set("query parser", "simple");
    this.set("subdomain offset", 2);
    // Unlike Express, matching is case-sensitive unless this is turned off.
    this.set("case sensitive routing", true);
    this.set("strict routing", false);
    this.set("json spaces", undefined);
    this.set("json replacer", undefined);
    this.set("jsonp callback name", "callback");
    this.set("view", View);
    this.set("views", resolve("views"));
    this.locals.settings = this.settings;
    this.defaults = new Set(Object.keys(this.settings));

    for (const name in settings) this.set(name, settings[name]);

    // Like Express, views are cached in production unless set otherwise.
    if (!("view cache" in settings) && this.get("env") === "production") this.enable("view cache");

    // The app is a function, like Express's: it gets this object's fields
    // and prototype, and the constructor returns it instead.
    const app = function (req: IncomingMessage, res: ServerResponse, next?: (err?: any) => void) {
      app.handle(req, res, next);
    } as Pype;
    Object.setPrototypeOf(app, new.target.prototype);
    Object.assign(app, this);
    app.handler = (req, res) => app.handle(req, res);
    return app;
  }

  /**
   * Sets a setting. `"trust proxy"` and `"query parser"` accept the same
   * values as Express.
   *
   * @param name - Setting name, e.g. `"etag"` or `"json spaces"`.
   * @param value - New value; without it, like Express, the setting is read.
   */
  set(name: string): any;
  set(name: string, value: any): this;
  set(name: string, value?: any): any {
    if (arguments.length === 1) return this.settings[name];

    // The compiled "<name> fn" counts as set too, so a mounted app keeps it.
    this.defaults.delete(name);
    this.defaults.delete(`${name} fn`);
    this.settings[name] = value;
    if (name === "etag")
      this.settings["etag fn"] = compileETag(value);
    if (name === "trust proxy")
      this.settings["trust proxy fn"] = compileTrust(value);
    if (name === "query parser")
      this.settings["query parser fn"] = compileQueryParser(value);
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
   * Takes the arguments of `server.listen()`, like Express. The callback is
   * called once: when the server listens, or with the error when it can't
   * (a port in use, for example).
   *
   * @param port - Port to listen on, `0` picks a free one.
   * @param hostname - Interface to bind, e.g. `"127.0.0.1"` behind a proxy.
   * @param backlog - Most pending connections.
   * @param callback - Called once the server is listening, or with an error.
   * @returns The underlying `http.Server`, e.g. for graceful shutdown.
   * @throws When routes conflict, e.g. different param names at one position.
   */
  listen(port?: number, callback?: (err?: Error) => void): Server;
  listen(port: number, hostname: string, callback?: (err?: Error) => void): Server;
  listen(port: number, hostname: string, backlog: number, callback?: (err?: Error) => void): Server;
  listen(...args: any[]): Server {
    this.compile();

    const server = createServer(
      // Requests of this server are created with the app's prototypes.
      { IncomingMessage: this.requestClass, ServerResponse: this.responseClass },
      this.handler,
    );

    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      let called = false;
      const done = (err?: Error) => {
        if (called) return;
        called = true;
        callback(err);
      };
      args[args.length - 1] = done;
      server.once("error", done);
    }
    return server.listen(...args);
  }

  /** The app as a request listener; the app itself works as one too. */
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
  use(path: PathParam, ...handlers: Array<Middleware | Middleware[]>): this;
  use(
    path: PathParam,
    ...handlers: Array<Middleware | Middleware[] | PypeRouter>
  ): this;
  use(...handlers: ErrorMiddleware[]): this;
  use(path: PathParam, ...handlers: ErrorMiddleware[]): this;
  use(...handlers: UseHandler[]): this;
  use(path: PathParam, ...handlers: UseHandler[]): this;
  use(...args: any[]): this {
    const use = (this.router.use as (...args: any[]) => PypeRouter).bind(this.router);
    const path: PathParam = isPathArgument(args[0]) ? args[0] : "/";
    const handlers = (isPathArgument(args[0]) ? args.slice(1) : args).flat(Infinity);
    if (handlers.length === 0) throw new TypeError("app.use() requires a middleware function");
    if (!handlers.some((handler) => handler instanceof Pype)) {
      use(...args);
      return this;
    }

    for (const handler of handlers) {
      if (!(handler instanceof Pype)) {
        use(path, handler);
        continue;
      }

      // Like Express: the mounted app knows where it is, inherits the
      // settings and engines it didn't set, and hands requests it doesn't
      // answer back to this app.
      handler.mountpath = path;
      handler.parent = this;
      for (const name of INHERITED_SETTINGS) {
        if (handler.defaults.has(name)) delete handler.settings[name];
      }
      Object.setPrototypeOf(handler.settings, this.settings);
      Object.setPrototypeOf(handler.engines, this.engines);
      Object.setPrototypeOf(handler.request, this.request);
      Object.setPrototypeOf(handler.response, this.response);
      use(path, function mountedApp(req: Request, res: Response, next: NextFunction) {
        handler.handle(req, res, next);
      });
      handler.emit("mount", this);
    }
    return this;
  }

  /** The full path the app is mounted on, `""` for the top app, like Express's `app.path()`. */
  path(): string {
    return this.parent ? this.parent.path() + this.mountpath : "";
  }

  /**
   * With one argument, reads a setting. Otherwise adds a GET route.
   *
   * @param path - Setting name, or route path such as `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  get(setting: string): any;
  get(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  get(path: PathParam, ...handlers: HandlerParam[]): this;
  get(path: PathParam, ...handlers: HandlerParam[]): any {
    if (handlers.length === 0) return this.settings[path as string];
    this.router.get(path, ...handlers);
    return this;
  }

  /**
   * Adds a route for every HTTP method.
   *
   * @param path - Route path, e.g. `/users/:id`.
   * @param handlers - Handlers or arrays of handlers, run in order.
   */
  all(path: PathParam, ...handlers: Array<RouteHandler | RouteHandler[]>): this;
  all(path: PathParam, ...handlers: HandlerParam[]): this;
  all(path: PathParam, ...handlers: HandlerParam[]): this {
    this.router.all(path, ...handlers);
    return this;
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
    this.router.post(path, ...handlers);
    return this;
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
    this.router.put(path, ...handlers);
    return this;
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
    this.router.patch(path, ...handlers);
    return this;
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
    this.router.delete(path, ...handlers);
    return this;
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
    path: PathParam,
    ...handlers: Array<RouteHandler | RouteHandler[]>
  ): this;
  options(path: PathParam, ...handlers: HandlerParam[]): this;
  options(path: PathParam, ...handlers: HandlerParam[]): this {
    this.router.options(path, ...handlers);
    return this;
  }

  /**
   * Starts a chainable route definition for one path.
   *
   * @example app.route("/users").get(list).post(create)
   */
  route(path: PathParam) {
    return this.router.route(path);
  }

  /**
   * Registers a template engine for an extension, like Express:
   * `fn(path, options, callback)` renders the file. Without a registered
   * engine, the npm module named after the extension is loaded
   * (`require("pug").__express`).
   *
   * @param ext - Extension, with or without the dot.
   * @throws When `fn` isn't a function.
   * @example app.engine("html", require("ejs").renderFile)
   */
  engine(ext: string, fn: Engine): this {
    if (typeof fn !== "function") throw new Error("callback function required");
    this.engines[ext.startsWith(".") ? ext : `.${ext}`] = fn;
    return this;
  }

  /**
   * Renders a view to HTML, like Express's `app.render()`. Options are
   * `app.locals`, then `options._locals` (what `res.render()` passes as
   * `res.locals`), then `options`. `options.cache` defaults to the
   * `"view cache"` setting, which is on when `env` is `"production"`.
   *
   * @param name - View name relative to the `"views"` directories; the
   * `"view engine"` extension is added when it has none.
   * @param options - Values for the template, or the callback.
   * @param callback - Called with an error, or the HTML.
   */
  render(
    name: string,
    options: Record<string, any> | ((err: Error | null, html?: string) => void) = {},
    callback?: (err: Error | null, html?: string) => void,
  ): void {
    let done = callback!;
    // Like Express, null or undefined options are none.
    let opts = (options || {}) as Record<string, any>;
    if (typeof options === "function") {
      done = options as (err: Error | null, html?: string) => void;
      opts = {};
    }

    const renderOptions: Record<string, any> = { ...this.locals, ...opts._locals, ...opts };
    if (renderOptions.cache == null) renderOptions.cache = this.enabled("view cache");

    let view: View | undefined = renderOptions.cache ? this.cache[name] : undefined;
    if (!view) {
      const ViewClass = this.get("view") as typeof View;
      view = new ViewClass(name, {
        defaultEngine: this.get("view engine"),
        root: this.get("views"),
        engines: this.engines,
      });

      if (!view.path) {
        const root = view.root;
        const dirs =
          Array.isArray(root) && root.length > 1
            ? `directories "${root.slice(0, -1).join('", "')}" or "${root[root.length - 1]}"`
            : `directory "${root}"`;
        return done(Object.assign(new Error(`Failed to lookup view "${name}" in views ${dirs}`), { view }));
      }

      if (renderOptions.cache) this.cache[name] = view;
    }

    try {
      view.render(renderOptions, done);
    } catch (error) {
      done(error as Error);
    }
  }

  /**
   * Adds a callback for a route parameter of the app's own routes, like
   * Express's `app.param()`; see {@link PypeRouter.param}. Mounted routers
   * have their own `param()`.
   *
   * @param name - Parameter name, or an array of names.
   * @example app.param("id", async (req, res, next, id) => { req.user = await find(id); next(); })
   */
  param(name: string | string[], fn: ParamHandler): this {
    for (const each of [name].flat()) this.router.param(each, fn);
    return this;
  }

  /**
   * Rebuilds the layer list and route trie when routes or middleware changed.
   * Express allows several routes with the same method and path, they share
   * one trie entry and run in registration order.
   */
  private compile() {
    const caseSensitive = this.enabled("case sensitive routing");
    const strict = this.enabled("strict routing");
    if (this.compiledVersion === routingVersion() && this.caseSensitive === caseSensitive && this.strict === strict) {
      return;
    }

    const layers = this.router.compile();
    const routes = createRouteTable(caseSensitive, strict);

    // Like Express, each path is matched with the options of the router it
    // was registered on; routers without options follow the app.
    const optionsOf = (router: PypeRouter) => ({
      caseSensitive: router === this.router ? caseSensitive : (router.caseSensitive ?? caseSensitive),
      strict: router === this.router ? strict : (router.strict ?? strict),
    });

    for (const layer of layers) {
      if (layer.kind === "end") continue;
      const options = optionsOf(layer.routers[layer.routers.length - 1]);
      layer.caseMask = caseMaskOf(layer, optionsOf, caseSensitive);

      // The tree uses the app's settings. A path its router matches with
      // other options, or below a mount path that needs a mask, becomes a
      // pattern below the router's mount path, like paths with several
      // params in one segment. A middleware path "/" matches anything anyway.
      const own = layer.ownPath;
      const otherOptions = options.caseSensitive !== caseSensitive || options.strict !== strict;
      const needsPattern = layer.kind === "route" ? otherOptions || layer.caseMask : otherOptions && normalizeBase(own ?? "");
      if (own !== undefined && !layer.pathPattern && needsPattern) {
        layer.pathPattern = own;
        layer.keys = pathKeys(own);
        if (layer.kind === "route") layer.fullPath = layer.baseUrl;
        else layer.path = layer.base;
        layer.caseMask = caseMaskOf(layer, optionsOf, caseSensitive);
      }

      if (layer.pathPattern) {
        layer.pattern = compilePathPattern(layer.pathPattern, { ...options, end: layer.kind === "route" });
      }
    }
    const routeLayers = new Map<AnyHandler[], RouteLayer[]>();
    const entries = new Map<string, AnyHandler[]>();

    for (const layer of layers) {
      // Regular expression routes are matched in the pipeline, not the tree.
      if (layer.kind !== "route" || layer.pattern) continue;

      // With strict routing, a router's "/" route answers its mount path
      // with and without the trailing slash, like in Express: the router
      // sees "/" for both.
      const paths = strict && layer.baseUrl && layer.fullPath === `${layer.baseUrl}/` ? [layer.fullPath, layer.baseUrl] : [layer.fullPath];

      for (const method of layer.methods) {
        for (const fullPath of paths) {
          // Paths that only differ in case share an entry when case is
          // ignored, and in a trailing slash unless routing is strict.
          const path = strict ? fullPath.replace(/\/{2,}/g, "/") : normalizeBase(fullPath) || "/";
          const key = `${method} ${caseSensitive ? path : lowerAscii(path)}`;
          const existing = entries.get(key);

          if (existing) {
            routeLayers.get(existing)!.push(layer);
            continue;
          }

          const entry: AnyHandler[] = [];
          entries.set(key, entry);
          routeLayers.set(entry, [layer]);
          routes.register(fullPath, method, entry as RouteHandler[], {
            path: layer.fullPath,
            baseUrl: layer.baseUrl,
          });
        }
      }
    }

    this.layers = layers;
    this.routes = routes;
    this.routeLayers = routeLayers;
    this.routedMethods = [...new Set([...entries.keys()].map((key) => key.slice(0, key.indexOf(" "))))];
    this.layerIndex = new Map(layers.map((layer, index) => [layer, index]));
    this.fixedIndices = [];
    layers.forEach((layer, index) => {
      if (layer.kind !== "route" || layer.pattern) this.fixedIndices.push(index);
    });
    this.fixedLayers = this.fixedIndices.map((index) => layers[index]);
    this.compiledVersion = routingVersion();
    this.caseSensitive = caseSensitive;
    this.strict = strict;
  }

  /**
   * Runs a request through the layers in registration order. HEAD requests
   * fall back to GET routes, Node drops the body. `next("router")` skips the
   * remaining layers of the innermost router of the layer that called it.
   * An OPTIONS request that nothing answered gets an `Allow` list of the
   * path's methods, like Express.
   */
  private handle(rawReq: IncomingMessage, rawRes: ServerResponse, callback?: (err?: any) => void) {
    // Like Express's router, a request without a URL is passed on untouched.
    if (callback && !rawReq.url) return callback();

    const incomingParams = this.hostsRouter ? (rawReq as Request).params : undefined;
    const { req, res, restore } = this.prepare(rawReq, rawRes, callback !== undefined);
    const outerParams = this.hostsRouter ? callerParams.get(req) : undefined;
    if (this.hostsRouter) callerParams.set(req, incomingParams);

    // With a callback, as a mounted app: what nothing handled goes back to it.
    const finish = (err?: any) => {
      if (this.hostsRouter) callerParams.set(req, outerParams);
      if (!callback) return this.finalHandler(req, res, err);
      restore!();
      callback(err);
    };

    try {
      this.compile();
    } catch (error) {
      return finish(error);
    }

    let method = "";
    let match: ReturnType<RouteNode["match"]> = null;
    let decodeErrors: Map<RouteLayer, Error> | null = null;
    let optionsMethods: Map<PypeRouter, Set<string>> | null = null;
    let pathLayers: Set<RouteLayer> | null = null;
    let matchedLayers: Set<Layer> | null = null;
    let layers: Layer[] = [];
    let routedUrl: string | undefined;
    let routedMethod: string | undefined;
    let index = 0;
    let current: Layer | undefined;

    // Looks up the routes once. Like Express, which matches every layer
    // against the current URL, it looks again when middleware changed
    // req.url or req.method, and goes on after the layer that ran last.
    const route = () => {
      routedUrl = req.url;
      routedMethod = req.method;
      // Like Express, a request without a method only reaches all() routes.
      const methodless = typeof req.method !== "string" || req.method === "";
      method = methodless ? "" : req.method!.toLowerCase();

      match =
        this.routes.match(req.path, methodless ? HTTP_METHODS.GET : method) ??
        (method === HTTP_METHODS.HEAD
          ? this.routes.match(req.path, HTTP_METHODS.GET)
          : null);

      let matched = match ? this.routeLayers.get(match.handlers)! : [];
      if (methodless) matched = matched.filter((layer) => layer.methods === METHODS);

      // Like Express, a route whose path matches but whose params fail to
      // decode raises a 400 for every method, not only the ones it handles.
      // Only an escape can fail to decode.
      decodeErrors = req.path.includes("%") ? this.decodeErrorsFor(req.path) : null;

      // Automatic OPTIONS, like Express's router: each router collects the
      // methods of the routes it passes that match the path but don't handle
      // OPTIONS, and answers with them when it is done.
      optionsMethods = method === HTTP_METHODS.OPTIONS ? (optionsMethods ?? new Map()) : null;
      pathLayers = optionsMethods ? this.routeLayersFor(req.path) : null;
      matchedLayers = optionsMethods ? new Set<Layer>(matched) : null;
      // Usually only the matched routes: no Set or copies needed then.
      const candidates =
        pathLayers || decodeErrors ? [...new Set([...matched, ...(pathLayers ?? []), ...(decodeErrors?.keys() ?? [])])] : matched;
      layers = this.dispatchOrder(candidates);

      index = 0;
      if (current) {
        const ran = this.layerIndex.get(current)!;
        while (index < layers.length && this.layerIndex.get(layers[index])! <= ran) index++;
      }
    };
    route();

    let paramCalls: Map<PypeRouter, Record<string, ParamCall>> | undefined;
    const getParamCalls = () => (paramCalls ??= new Map());
    let ranGroups: Set<object> | undefined;
    const routerDone = (router: PypeRouter | undefined) => {
      const methods = router && optionsMethods?.get(router);
      if (!methods?.size) return false;
      // Like Express, when the response can't be sent any more (headers
      // already sent), the error goes to the error middleware.
      try {
        sendOptions(res, [...methods].sort().join(", "));
      } catch (error) {
        next(error);
      }
      return true;
    };
    // Like Express, a long run of layers that call next() synchronously
    // continues on the next tick now and then, so the stack can't overflow.
    let sync = 0;

    const next = (err?: any): void => {
      if (++sync > 100) {
        setImmediate(next, err);
        return;
      }
      if (req.url !== routedUrl || req.method !== routedMethod) {
        if (req.url !== routedUrl) {
          req.query = this.settings["query parser fn"](queryOf(req.url ?? "/"));
        }
        route();
      }
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
        if (routerDone(router)) return;
      }

      while (index < layers.length) {
        const layer = layers[index++];
        // An array path is one layer in Express: it runs at most once.
        if (layer.group && ranGroups?.has(layer.group)) continue;

        if (layer.kind === "end") {
          // Like Express, a mount path's param() callbacks run when the path
          // matches, even if nothing in the router did; cached, they don't
          // run twice.
          if (!err && layer.mounts.some((scope) => scope.keys.length > 0 && scope.router.hasParams)) {
            if (matchesPrefix(req.path, layer.path, this.caseSensitive)) {
              current = layer;
              this.enterParams(req, res, layer, {}, [], req.path, getParamCalls, (error) => {
                if (error) return next(error);
                if (!routerDone(layer.router)) next();
              });
              sync = 0;
              return;
            }
          }
          if (!err && routerDone(layer.router)) return;
          continue;
        }

        if (layer.kind === "route") {
          // Like Express, routes don't run while an error is pending; only
          // errors raised inside a route reach its error handlers.
          if (err) continue;

          const decodeError = decodeErrors?.get(layer);
          if (decodeError) {
            err = decodeError;
            continue;
          }

          if (optionsMethods && !layer.methods.includes(HTTP_METHODS.OPTIONS) && routeMatchesPath(layer, req.path, pathLayers!, layer.caseMask ?? this.caseSensitive)) {
            const router = layer.routers[layer.routers.length - 1];
            if (!optionsMethods.has(router)) optionsMethods.set(router, new Set());
            const methods = optionsMethods.get(router)!;
            for (const name of layer.methods) methods.add(name.toUpperCase());
            if (layer.methods.includes(HTTP_METHODS.GET)) methods.add("HEAD");
            continue;
          }

          let params: Record<string, string>;
          if (layer.pattern) {
            // The pattern is matched below the router's mount path, which
            // the request must be under, as for middleware.
            if (!matchesPrefix(req.path, layer.fullPath, layer.caseMask ?? this.caseSensitive)) continue;
            let found: PatternMatch | null;
            try {
              const path = relativePath(req.path, layer.fullPath, layer.caseMask ?? this.caseSensitive);
              found = matchPattern(layer.pattern, path, layer.pathPattern ? layer.keys : undefined);
            } catch (error) {
              // Like Express, a param that fails to decode is a 400 for every method.
              err = error;
              continue;
            }
            if (!found || !handlesMethod(layer, method)) continue;
            params = found.params;
          } else {
            // Only matched route layers are in the order, plus, for OPTIONS,
            // the path's other routes, which were handled above.
            if (matchedLayers && !matchedLayers.has(layer)) continue;
            params = pickParams(match!.params, layer.keys);
          }

          if (layer.group) (ranGroups ??= new Set()).add(layer.group);
          current = layer;
          this.runRoute(req, res, layer, params, getParamCalls, next);
          sync = 0;
          return;
        }

        const caseSensitive = layer.caseMask ?? this.caseSensitive;
        if (!matchesPrefix(req.path, layer.path, caseSensitive)) continue;

        let mounted: PatternMatch | null = null;
        try {
          if (layer.pattern) {
            const path = relativePath(req.path, layer.path, caseSensitive);
            mounted = matchMount(layer.pattern, path, layer.pathPattern ? layer.keys : undefined);
            if (!mounted) continue;
          } else if (layer.keys.length > 0) {
            mounted = { params: pickParams(mountParams(req.path, layer.path, caseSensitive), layer.keys), path: "" };
          }
        } catch (error) {
          err = err || error;
          continue;
        }

        const isErrorHandler = layer.handle.length === 4;
        if (Boolean(err) !== isErrorHandler) continue;

        if (layer.group) (ranGroups ??= new Set()).add(layer.group);
        current = layer;
        this.callMiddleware(req, res, layer, err, next, mounted, getParamCalls);
        sync = 0;
        return;
      }

      if (!err && routerDone(this.router)) return;

      finish(err);
    };

    req.next = next;
    next();
  }

  /**
   * The layers a request walks, in registration order: the fixed layers
   * merged with the route layers the tree matched.
   */
  private dispatchOrder(routeLayers: RouteLayer[]): Layer[] {
    if (routeLayers.length === 0) return this.fixedLayers;
    // Without middleware or RegExp routes, the matched routes are the order.
    if (this.fixedIndices.length === 0 && routeLayers.length === 1) return routeLayers;

    const routeIndices = routeLayers.map((layer) => this.layerIndex.get(layer)!).sort((a, b) => a - b);
    const fixed = this.fixedIndices;
    const order: Layer[] = [];
    let f = 0;
    let r = 0;
    while (f < fixed.length || r < routeIndices.length) {
      const next = r >= routeIndices.length || (f < fixed.length && fixed[f] < routeIndices[r]) ? fixed[f++] : routeIndices[r++];
      order.push(this.layers[next]);
    }
    return order;
  }

  /** Route layers in the tree that match `path` for some method but whose params fail to decode, with the error. */
  private decodeErrorsFor(path: string): Map<RouteLayer, Error> | null {
    let found: Map<RouteLayer, Error> | null = null;
    for (const method of this.routedMethods) {
      const match = this.routes.match(path, method);
      if (!match?.error) continue;
      for (const layer of this.routeLayers.get(match.handlers) ?? []) (found ??= new Map()).set(layer, match.error);
    }
    return found;
  }

  /** Route layers in the tree that match `path` for any method, for automatic OPTIONS. */
  private routeLayersFor(path: string): Set<RouteLayer> {
    const found = new Set<RouteLayer>();
    for (const method of this.routedMethods) {
      const match = this.routes.match(path, method);
      // A param that fails to decode makes Express skip the route.
      if (!match || match.error) continue;
      for (const layer of this.routeLayers.get(match.handlers) ?? []) found.add(layer);
    }
    return found;
  }

  /**
   * Gives requests from `http.createServer(app)` the Pype prototypes and
   * resets per-request state, like Express does.
   *
   * Duplicate slashes are collapsed in `req.path` and `req.url` here, once,
   * so path-scoped middleware sees the same path the router matches.
   * Otherwise `//admin/secret` could reach an `/admin/secret` route without
   * running middleware mounted on `/admin`. `req.originalUrl` keeps the raw URL.
   *
   * @param mounted - The app runs inside another one, which already set
   * `req.originalUrl` and `req.baseUrl`; `restore()` gives the request back
   * as it was, like Express when a mounted app is done.
   */
  private prepare(rawReq: IncomingMessage, rawRes: ServerResponse, mounted = false) {
    const saved = mounted
      ? {
          app: (rawReq as Request).app,
          resApp: (rawRes as Response).app,
          next: (rawReq as Request).next,
          params: (rawReq as Request).params,
          query: (rawReq as Request).query,
          requestProto: Object.getPrototypeOf(rawReq),
          responseProto: Object.getPrototypeOf(rawRes),
        }
      : undefined;

    // Like Express, requests get the app's prototypes, app.request and
    // app.response; a router's hidden app only makes sure they are Pype's.
    if (this.hostsRouter) {
      if (!(rawReq instanceof Request)) Object.setPrototypeOf(rawReq, Request.prototype);
      if (!(rawRes instanceof Response)) Object.setPrototypeOf(rawRes, Response.prototype);
    } else {
      if (Object.getPrototypeOf(rawReq) !== this.request) Object.setPrototypeOf(rawReq, this.request);
      if (Object.getPrototypeOf(rawRes) !== this.response) Object.setPrototypeOf(rawRes, this.response);
    }

    const req = rawReq as Request;
    const res = rawRes as Response;
    const url = req.url || "/";
    const queryStart = url.indexOf("?");
    // Like Express, an absolute URL (as sent to proxies) is routed by its
    // path, and req.url keeps its scheme and host in front.
    const host = protohostOf(url);
    const rawPath = url.slice(host.length, queryStart === -1 ? url.length : queryStart);
    const collapsed = rawPath.includes("//") ? rawPath.replace(/\/{2,}/g, "/") : rawPath;
    const path = collapsed || "/";
    const parser = this.settings["query parser fn"];
    // Inside another Pype app, req.query is parsed again only with another parser.
    const parseQuery =
      !this.hostsRouter && (!mounted || !(saved!.app instanceof Pype) || saved!.app.settings["query parser fn"] !== parser);

    if (!this.hostsRouter) {
      req.app = this;
      res.app = this;
    }
    req.res = res;
    req.originalUrl = (mounted && req.originalUrl) || url;
    req.path = path;
    req.url = collapsed === rawPath ? url : host + collapsed + url.slice(host.length + rawPath.length);
    if (parseQuery) req.query = parser(queryStart === -1 ? null : url.slice(queryStart + 1));
    req.baseUrl = (mounted && req.baseUrl) || "";
    req.params = {};
    res.locals = res.locals || {};
    if (this.settings["x-powered-by"] && !this.hostsRouter) res.setHeader("X-Powered-By", "Pype");

    const restore = saved
      ? () => {
          req.app = saved.app;
          res.app = saved.resApp;
          req.next = saved.next;
          req.params = saved.params;
          req.query = saved.query;
          Object.setPrototypeOf(req, saved.requestProto);
          Object.setPrototypeOf(res, saved.responseProto);
        }
      : undefined;

    return { req, res, restore };
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
    mounted: PatternMatch | null,
    getParamCalls: () => Map<PypeRouter, Record<string, ParamCall>>,
  ) {
    const { url, path, baseUrl } = req;
    // Like Express, middleware sees the params of its own mount path, and the
    // router's param() callbacks run for a regular expression's groups too.
    // A string mount path's params come with an empty `mounted.path`: the
    // layer's path already mounts that part.
    const params = mounted ? mounted.params : {};

    this.enterParams(req, res, layer, params, Object.keys(params), path, getParamCalls, (error) => {
      if (error) return next(error);

      mount(req, layer.path, layer.caseMask ?? this.caseSensitive);
      if (mounted) mount(req, mounted.path);
      const mountedUrl = req.url;

      const done = once((error?: any) => {
        unmount(req, url, path, baseUrl, mountedUrl);
        next(error);
      });

      // Like Express, req.next is the next the middleware got, which
      // res.format(), res.render() and res.sendFile() call.
      req.next = done;
      invoke(layer.handle, err, req, res, done);
    });
  }

  /**
   * Sets `req.params` for a layer like Express's nested routers do: each
   * router sees the params of its own paths, plus its parent's when it was
   * created with `mergeParams`. The `param()` callbacks of each router run
   * for the params of the paths registered on it, outermost first, so
   * `app.param("org")` runs for `app.use("/orgs/:org", router)`.
   *
   * @param params - The layer's own params.
   * @param keys - Their names, for the callbacks of the layer's router.
   * @param requestPath - The path the mount paths' params are read from.
   * @param done - Called once `req.params` is set, or with a callback's error.
   */
  private enterParams(
    req: Request,
    res: Response,
    layer: Pick<RouteLayer, "mounts" | "routers" | "caseMask">,
    params: Record<string, string>,
    keys: string[],
    requestPath: string,
    getParamCalls: () => Map<PypeRouter, Record<string, ParamCall>>,
    done: (err?: any) => void,
  ) {
    // Most layers have no params to look up and no callbacks to run.
    const router = layer.routers[layer.routers.length - 1];
    if (!this.hostsRouter && (keys.length === 0 || !router.hasParams) && layer.mounts.every((scope) => scope.keys.length === 0)) {
      req.params = router.mergeParams && layer.mounts.length > 0 ? { ...params } : params;
      return done();
    }

    const runCallbacks = (router: PypeRouter, names: string[], next: (err?: any) => void) => {
      if (names.length === 0 || !router.hasParams) return next();
      const paramCalls = getParamCalls();
      let calls = paramCalls.get(router);
      if (!calls) paramCalls.set(router, (calls = Object.create(null) as Record<string, ParamCall>));
      processParams(router.params, names, calls, req, res, next);
    };

    // Callbacks may change req.params, the next router down inherits that.
    // A router called as a function starts from the params it was called with.
    const called = this.hostsRouter ? callerParams.get(req) : undefined;
    let parent = typeof called === "object" && called !== null ? (called as Record<string, string>) : undefined;
    let level = 0;
    const enter = (error?: any): void => {
      if (error) return done(error);
      if (level < layer.mounts.length) {
        const scope = layer.mounts[level++];
        // Each mount path's own segments, so a name used at two levels keeps both values.
        let own: Record<string, string> = {};
        try {
          if (scope.keys.length > 0) {
            own = pickParams(mountParams(requestPath, scope.path, layer.caseMask ?? this.caseSensitive), scope.keys);
          }
        } catch (decodeError) {
          return done(decodeError);
        }
        req.params = parent = mergeParams(scope.router.mergeParams, own, parent);
        return runCallbacks(scope.router, scope.keys, enter);
      }
      req.params = mergeParams(router.mergeParams, params, parent);
      runCallbacks(router, keys, done);
    };
    enter();
  }

  /**
   * Runs a route: first the `param()` callbacks of the route's router for
   * its parameters, then its handlers in order. Four-argument handlers run
   * for errors raised inside the route; `next("route")` leaves it early.
   *
   * @param getParamCalls - `param()` results of this request, by router, created on first use.
   */
  private runRoute(
    req: Request,
    res: Response,
    layer: RouteLayer,
    params: Record<string, string>,
    getParamCalls: () => Map<PypeRouter, Record<string, ParamCall>>,
    next: (err?: any) => void,
  ) {
    const { url, path, baseUrl } = req;
    mount(req, layer.baseUrl, layer.caseMask ?? this.caseSensitive);
    const mountedUrl = req.url;

    const leave = (error?: any) => {
      unmount(req, url, path, baseUrl, mountedUrl);
      next(error);
    };
    // In a route, req.next leaves it for the following layers, like Express's router next.
    req.next = once(leave);

    // The route runs its handlers for the method and sets req.route, like Express.
    const keys = layer.pattern ? Object.keys(params) : layer.keys;
    this.enterParams(req, res, layer, params, keys, path, getParamCalls, (error) =>
      error ? leave(error) : layer.route.dispatch(req, res, leave),
    );
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

// Apps are functions, see the constructor: `app.call()` and
// `app instanceof Function` work like with Express.
Object.setPrototypeOf(Pype.prototype, Function.prototype);

/** The params a router called as a function was called with, by request. */
const callerParams = new WeakMap<object, unknown>();

/** The hidden app that runs each router called as a function. */
const routerHosts = new WeakMap<PypeRouter, Pype>();

// A router called as a function runs in a hidden app of its own, with the
// routing settings of the app the request is in.
setRouterRunner((router, req, res, next) => {
  let host = routerHosts.get(router);
  if (!host) {
    host = new Pype();
    (host as any).hostsRouter = true;
    // Its root passes the caller's params down to a mergeParams router.
    (host.router as { mergeParams: boolean }).mergeParams = true;
    host.use(router);
    routerHosts.set(router, host);
  }
  const app = (req as Request).app;
  if (app instanceof Pype) {
    host.set("case sensitive routing", app.enabled("case sensitive routing"));
    host.set("strict routing", app.enabled("strict routing"));
  }
  (host as any).handle(req, res, next);
});

// Like Express apps, apps are event emitters: `app.on("mount", parent => ...)`.
for (const name of Object.getOwnPropertyNames(EventEmitter.prototype)) {
  if (name === "constructor" || Object.prototype.hasOwnProperty.call(Pype.prototype, name)) continue;
  Object.defineProperty(Pype.prototype, name, Object.getOwnPropertyDescriptor(EventEmitter.prototype, name)!);
}

// Every other HTTP method gets a route method too, like in Express. On the
// app, that includes `bind` for BIND, which replaces Function's `bind` as
// it does on an Express app.
for (const method of METHODS) {
  if (Object.prototype.hasOwnProperty.call(Pype.prototype, method)) continue;
  Object.defineProperty(Pype.prototype, method, {
    configurable: true,
    writable: true,
    value(this: Pype, path: PathParam, ...handlers: HandlerParam[]) {
      (this as any).router[method](path, ...handlers);
      return this;
    },
  });
}

/** Creates the route trie with Express's slash handling; a trailing slash counts with strict routing. */
function createRouteTable(caseSensitive = true, strict = false) {
  return new RouteNode({
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: !strict,
    caseSensitive,
  });
}

/** The result of a parameter's `param()` callbacks in one request, reused for the same value. */
interface ParamCall {
  error: any;
  /** The value the callbacks ran for. */
  match: string;
  /** `req.params[name]` after the callbacks, which may have changed it. */
  value: string;
}

/**
 * Runs `param()` callbacks for a route's parameters, the algorithm of
 * Express's router: callbacks of one parameter run in order, and a value that
 * already ran in this request reuses the result, unless it ended with
 * `next("route")`.
 */
function processParams(
  callbacks: Record<string, ParamHandler[]>,
  keys: string[],
  called: Record<string, ParamCall>,
  req: Request,
  res: Response,
  done: (err?: any) => void,
) {
  let i = 0;
  let fnIndex = 0;
  let key: string;
  let value: string;
  let fns: ParamHandler[] | undefined;
  let call: ParamCall;

  const param = (err?: any): void => {
    if (err) return done(err);
    if (i >= keys.length) return done();

    fnIndex = 0;
    key = keys[i++];
    value = req.params[key];
    fns = callbacks[key];
    const previous = called[key];

    if (value === undefined || !fns) return param();
    if (previous && (previous.match === value || (previous.error && previous.error !== "route"))) {
      req.params[key] = previous.value;
      return param(previous.error);
    }

    called[key] = call = { error: null, match: value, value };
    paramCallback();
  };

  const paramCallback = (err?: any): void => {
    const fn = fns![fnIndex++];
    call.value = req.params[key];

    if (err) {
      call.error = err;
      return param(err);
    }
    if (!fn) return param();

    try {
      const result = fn(req, res, paramCallback, value, key);
      if (result && typeof result.then === "function") {
        result.then(undefined, (error: unknown) => paramCallback(error || new Error("Rejected promise")));
      }
    } catch (error) {
      paramCallback(error);
    }
  };

  param();
}

/** A regular expression path that matched: its params and the matched text. */
interface PatternMatch {
  params: Record<string, string>;
  path: string;
}

/**
 * Finds the capture groups of a regular expression path the way Express's
 * router does, by scanning its source: named groups keep their name, the
 * others are numbered from 0.
 */
const MATCHING_GROUP = /\((?:\?<(.*?)>)?(?!\?)/g;

/** Group names of each regular expression path, computed once. */
const patternKeys = new WeakMap<RegExp, Array<string | number>>();

function keysOf(pattern: RegExp) {
  let keys = patternKeys.get(pattern);
  if (!keys) {
    keys = [];
    let unnamed = 0;
    for (const group of pattern.source.matchAll(MATCHING_GROUP)) keys.push(group[1] || unnamed++);
    patternKeys.set(pattern, keys);
  }
  return keys;
}

/**
 * Matches a regular expression route path like Express: params come from the
 * capture groups, URL-decoded, and groups that didn't take part are left out.
 *
 * @param keys - The param name of each group; read from the pattern's source when omitted.
 * @throws A 400 error when a param has a malformed escape.
 */
function matchPattern(pattern: RegExp, path: string, keys: Array<string | number> = keysOf(pattern)): PatternMatch | null {
  const match = pattern.exec(path);
  if (!match) return null;

  const params: Record<string, string> = {};
  for (let i = 1; i < match.length; i++) {
    const value = decodeParam(match[i]);
    if (value !== undefined) params[keys[i - 1] ?? i - 1] = value;
  }
  return { params, path: match[0] };
}

/**
 * Matches a regular expression mount path like Express: the match must start
 * the path and end at a `/` or the end of it.
 */
function matchMount(pattern: RegExp, path: string, keys?: Array<string | number>): PatternMatch | null {
  const match = matchPattern(pattern, path, keys);
  if (!match || !path.startsWith(match.path)) return null;
  const next = path[match.path.length];
  return next && next !== "/" ? null : match;
}

/** Decodes a captured param like Express's router, with a 400 for malformed escapes. */
function decodeParam(value: string | undefined) {
  if (typeof value !== "string" || value.length === 0) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new URIError(`Failed to decode param '${value}'`), { status: 400, statusCode: 400 });
  }
}

/** The request path below a mount path. */
function relativePath(path: string, mountPath: string, caseSensitive: CaseSensitivity) {
  return path.slice((matchedPrefix(path, mountPath, caseSensitive) ?? normalizeBase(mountPath)).length) || "/";
}

/** Whether a route's path matches the request, whatever the method; for automatic OPTIONS. */
function routeMatchesPath(layer: RouteLayer, path: string, treeLayers: Set<RouteLayer>, caseSensitive: CaseSensitivity) {
  if (!layer.pattern) return treeLayers.has(layer);
  if (!matchesPrefix(path, layer.fullPath, caseSensitive)) return false;
  try {
    return matchPattern(layer.pattern, relativePath(path, layer.fullPath, caseSensitive)) !== null;
  } catch {
    return false;
  }
}

/** Whether a route handles a method, HEAD falling back to GET like Express. */
function handlesMethod(layer: RouteLayer, method: string) {
  if (method === "") return layer.methods === METHODS;
  if (layer.methods.includes(method)) return true;
  return method === HTTP_METHODS.HEAD && layer.methods.includes(HTTP_METHODS.GET);
}

/** Makes the `ETag` of a `res.send()` body, `undefined` for none. */
type ETagFunction = (body: string | Buffer) => string | undefined;

/**
 * Compiles an Express `"etag"` setting: `true` or `"weak"` for weak ETags,
 * `"strong"` for strong ones, `false` for none, or a function
 * `(body, encoding) => etag`.
 *
 * @throws When the value is none of those.
 */
function compileETag(value: unknown): ETagFunction | undefined {
  // Like Express, a custom function is used as it is; res.send() gives it the body as a Buffer.
  if (typeof value === "function") return value as ETagFunction;
  switch (value) {
    case true:
    case "weak":
      return generateETag;
    case "strong":
      return generateStrongETag;
    case false:
      return undefined;
    default:
      throw new TypeError(`unknown value for etag function: ${value}`);
  }
}

/** Parses `req.query` from the text after `?`, `null` without a `?`. */
type QueryParser = (query: string | null) => any;

/**
 * Compiles an Express `"query parser"` setting: `"simple"` or `true` for
 * Node's `querystring`, `"extended"` for `qs` rules with nested objects and
 * arrays, `false` for no parsing, or a custom function.
 *
 * @throws When the value is none of those.
 */
function compileQueryParser(value: unknown): QueryParser {
  if (typeof value === "function") return value as QueryParser;
  switch (value) {
    case true:
    case "simple":
      return (query) => (query === null ? Object.create(null) : parseQuery(query));
    case false:
      return () => Object.create(null);
    case "extended":
      return (query) => parseQs(query ?? "");
    default:
      throw new TypeError(`unknown value for query parser function: ${value}`);
  }
}

/** Answers an OPTIONS request nothing handled, like Express's router. */
function sendOptions(res: Response, allow: string) {
  res.setHeader("Allow", allow);
  res.setHeader("Content-Length", Buffer.byteLength(allow));
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(allow);
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
  if (base === "") return base;
  return base.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** `/some` matches `/some` and `/some/...`, but not `/something`. */
function matchesPrefix(requestPath: string, prefix: string, caseSensitive: CaseSensitivity) {
  return matchedPrefix(requestPath, prefix, caseSensitive) !== null;
}

/** Case sensitivity of a whole path, or of each of its segments, see {@link MiddlewareLayer.caseMask}. */
type CaseSensitivity = boolean | boolean[];

/**
 * The start of `requestPath` that a mount path matches, compared segment by
 * segment so that a `:param` segment matches any one segment: `/r/:org`
 * matches `/r/acme/42` as `/r/acme`. `null` when it doesn't match.
 *
 * @param caseSensitive - `false` ignores ASCII case, an array decides it per
 * segment. The result is always the request's own text, so `req.baseUrl`
 * keeps its case like in Express.
 */
function matchedPrefix(requestPath: string, prefix: string, caseSensitive: CaseSensitivity = true): string | null {
  if (Array.isArray(caseSensitive)) return matchedPrefixBySegment(requestPath, normalizeBase(prefix), caseSensitive);

  const base = caseSensitive ? normalizeBase(prefix) : lowerAscii(normalizeBase(prefix));
  const path = caseSensitive ? requestPath : lowerAscii(requestPath);
  if (!base.includes("/:")) {
    const matches = base === "" || path === base || path.startsWith(base + "/");
    return matches ? requestPath.slice(0, base.length) : null;
  }

  const expected = base.split("/");
  const actual = path.split("/");
  if (actual.length < expected.length) return null;
  for (let i = 0; i < expected.length; i++) {
    const matches = expected[i].startsWith(":") ? actual[i] !== "" : actual[i] === expected[i];
    if (!matches) return null;
  }
  return requestPath.split("/").slice(0, expected.length).join("/");
}

/** {@link matchedPrefix} with the case sensitivity of each segment. */
function matchedPrefixBySegment(requestPath: string, base: string, mask: boolean[]): string | null {
  const expected = base.split("/");
  const actual = requestPath.split("/");
  if (actual.length < expected.length) return null;
  for (let i = 0; i < expected.length; i++) {
    const segment = expected[i];
    const matches = segment.startsWith(":")
      ? actual[i] !== ""
      : mask[i] === false
        ? lowerAscii(actual[i]) === lowerAscii(segment)
        : actual[i] === segment;
    if (!matches) return null;
  }
  return actual.slice(0, expected.length).join("/");
}

/**
 * Whether each segment of a layer's mount path is matched with case, when a
 * router above it uses another `caseSensitive` than the app; `undefined`
 * when the app's setting applies to all of them. Segments of a mount path
 * follow the router it was registered on.
 */
function caseMaskOf(
  layer: RouteLayer | MiddlewareLayer,
  optionsOf: (router: PypeRouter) => { caseSensitive: boolean },
  appCaseSensitive: boolean,
): boolean[] | undefined {
  const mask: boolean[] = [true];
  let differs = false;
  for (const scope of layer.mounts) {
    const sensitive = optionsOf(scope.router).caseSensitive;
    differs ||= sensitive !== appCaseSensitive;
    const count = normalizeBase(scope.path).split("/").length;
    while (mask.length < count) mask.push(sensitive);
  }

  const own = optionsOf(layer.routers[layer.routers.length - 1]).caseSensitive;
  const path = layer.kind === "route" ? (layer.pattern || layer.pathPattern ? layer.baseUrl : layer.fullPath) : layer.path;
  const count = normalizeBase(path).split("/").length;
  while (mask.length < count) mask.push(own);
  differs ||= mask.some((sensitive) => sensitive !== appCaseSensitive);
  return differs ? mask : undefined;
}

/**
 * The `:param` values of a mount path like `/orgs/:org`, URL-decoded.
 *
 * @throws A 400 error when a param has a malformed escape.
 */
function mountParams(requestPath: string, mountPath: string, caseSensitive: CaseSensitivity): Record<string, string> {
  const segments = matchedPrefix(requestPath, mountPath, caseSensitive)!.split("/");
  const params: Record<string, string> = {};
  normalizeBase(mountPath).split("/").forEach((segment, i) => {
    if (segment.startsWith(":")) params[segment.slice(1).replace(/\?$/, "")] = decodeParam(segments[i])!;
  });
  return params;
}

/** The params named `keys`, the ones a layer's own path has. */
function pickParams(source: Record<string, string>, keys: string[]) {
  const params: Record<string, string> = {};
  for (const key of keys) if (source[key] !== undefined) params[key] = source[key];
  return params;
}

/**
 * Express's `mergeParams`: the parent's params, overridden by the layer's.
 * Express also renumbers regular expression groups when both have them, but
 * a parent here only has named params: routers can't be mounted on a RegExp.
 */
function mergeParams(enabled: boolean, params: Record<string, string>, parent?: Record<string, string>) {
  return enabled && typeof parent === "object" && parent !== null ? { ...parent, ...params } : params;
}

/**
 * Puts `req.url`, `req.path` and `req.baseUrl` back after a layer that
 * {@link mount} ran. Like Express, a `req.url` the layer changed is kept,
 * with the mount path in front again, and `req.path` follows it.
 *
 * @param mountedUrl - `req.url` as the layer got it.
 */
function unmount(req: Request, url: string | undefined, path: string, baseUrl: string, mountedUrl: string | undefined) {
  if (req.url === mountedUrl) {
    req.url = url;
    req.path = path;
  } else {
    const rewritten = req.url ?? "";
    const host = protohostOf(rewritten);
    req.url = host + req.baseUrl.slice(baseUrl.length) + rewritten.slice(host.length);
    req.path = pathOf(req.url);
  }
  req.baseUrl = baseUrl;
}

/** The path of a URL, without the query and with duplicate slashes collapsed, see {@link Pype.prepare}. */
function pathOf(url: string) {
  const queryStart = url.indexOf("?");
  const path = url.slice(protohostOf(url).length, queryStart === -1 ? url.length : queryStart);
  return (path.includes("//") ? path.replace(/\/{2,}/g, "/") : path) || "/";
}

/**
 * The scheme and host of an absolute URL like `http://example.com/a`, `""`
 * for a path, like Express's router.
 */
function protohostOf(url: string) {
  if (url.length === 0 || url[0] === "/") return "";
  const queryStart = url.indexOf("?");
  const schemeEnd = url.slice(0, queryStart === -1 ? url.length : queryStart).indexOf("://");
  if (schemeEnd === -1) return "";
  const pathStart = url.indexOf("/", schemeEnd + 3);
  return pathStart === -1 ? url : url.slice(0, pathStart);
}

/** The query of a URL, `null` without a `?`. */
function queryOf(url: string) {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? null : url.slice(queryStart + 1);
}

/** Strips `base` from the front of `req.url` and `req.path` and appends it to `req.baseUrl`. */
function mount(req: Request, base: string, caseSensitive: CaseSensitivity = true) {
  // Layers of the app itself are mounted nowhere.
  if (base === "") return;
  const prefix = matchedPrefix(req.path, base, caseSensitive) ?? normalizeBase(base);
  if (!prefix) return;

  req.baseUrl = normalizeBase(req.baseUrl + prefix);
  req.path = req.path.slice(prefix.length) || "/";

  // An absolute URL keeps its scheme and host in front, like Express.
  const url = req.url || "/";
  const host = protohostOf(url);
  const rest = url.slice(host.length + prefix.length);
  req.url = host ? host + rest : rest.startsWith("?") || rest === "" ? `/${rest}` : rest;
}
