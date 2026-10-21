import {
  IncomingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  createServer,
} from "http";
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
  routingVersion,
} from "./router";
import { AnyHandler, ErrorMiddleware, Middleware } from "../types/middleware";
import { Request } from "./request";
import { Response } from "./response";
import { generateETag, generateStrongETag, parseQuery } from "../utils/helpers";
import { parseQs } from "../utils/qs";
import { compileTrust } from "../utils/trust-proxy";
import { resolve } from "path";
import { Engine, View } from "./view";

/** App settings, keyed by Express setting names such as `"trust proxy"`. */
type Settings = Record<string, any>;

/**
 * Like an Express app, a Pype app is a request listener itself:
 * `http.createServer(app)`, `https.createServer(options, app)` and
 * `supertest(app)` work.
 */
export interface Pype extends ExtraRouteMethods<Pype> {
  (req: IncomingMessage, res: ServerResponse): void;
}

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
  /** Values shared by the whole app and every view, like Express's `app.locals`. `locals.settings` is the app's settings. */
  locals: Record<string, any> = {};
  /** Template engines by extension, see {@link Pype.engine}. */
  engines: Record<string, Engine> = {};
  /** Views found so far by name, used when `"view cache"` is on. */
  cache: Record<string, View> = {};

  private readonly router = new PypeRouter();
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
    this.set("view", View);
    this.set("views", resolve("views"));
    this.locals.settings = this.settings;

    for (const name in settings) this.set(name, settings[name]);

    // Like Express, views are cached in production unless set otherwise.
    if (!("view cache" in settings) && this.get("env") === "production") this.enable("view cache");

    // The app is a function, like Express's: it gets this object's fields
    // and prototype, and the constructor returns it instead.
    const app = function (req: IncomingMessage, res: ServerResponse) {
      app.handle(req, res);
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
   * @param value - New value.
   */
  set(name: string, value: any): this {
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
  use(
    path: PathParam,
    ...handlers: Array<Middleware | Middleware[] | PypeRouter>
  ): this;
  use(...handlers: ErrorMiddleware[]): this;
  use(path: PathParam, ...handlers: ErrorMiddleware[]): this;
  use(...handlers: UseHandler[]): this;
  use(path: PathParam, ...handlers: UseHandler[]): this;
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
    let opts = options as Record<string, any>;
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
  private handle(rawReq: IncomingMessage, rawRes: ServerResponse) {
    const { req, res } = this.prepare(rawReq, rawRes);

    try {
      this.compile();
    } catch (error) {
      return this.finalHandler(req, res, error);
    }

    const method = (req.method || "GET").toLowerCase();

    const match =
      this.routes.match(req.path, method) ??
      (method === HTTP_METHODS.HEAD
        ? this.routes.match(req.path, HTTP_METHODS.GET)
        : null);

    const matched = match ? this.routeLayers.get(match.handlers)! : [];

    // Like Express, a route whose path matches but whose params fail to
    // decode raises a 400 for every method, not only the ones it handles.
    // Only an escape can fail to decode.
    const decodeErrors = req.path.includes("%") ? this.decodeErrorsFor(req.path) : null;

    // Automatic OPTIONS, like Express's router: each router collects the
    // methods of the routes it passes that match the path but don't handle
    // OPTIONS, and answers with them when it is done.
    const optionsMethods = method === HTTP_METHODS.OPTIONS ? new Map<PypeRouter, Set<string>>() : null;
    const pathLayers = optionsMethods ? this.routeLayersFor(req.path) : null;
    const matchedLayers = optionsMethods ? new Set<Layer>(matched) : null;
    const candidates = new Set([...matched, ...(pathLayers ?? []), ...(decodeErrors?.keys() ?? [])]);
    const layers = this.dispatchOrder([...candidates]);

    let paramCalls: Map<PypeRouter, Record<string, ParamCall>> | undefined;
    const getParamCalls = () => (paramCalls ??= new Map());
    let ranGroups: Set<object> | undefined;
    const routerDone = (router: PypeRouter | undefined) => {
      const methods = router && optionsMethods?.get(router);
      if (!methods?.size || res.headersSent) return false;
      sendOptions(res, [...methods].sort().join(", "));
      return true;
    };
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
        if (routerDone(router)) return;
      }

      while (index < layers.length) {
        const layer = layers[index++];
        // An array path is one layer in Express: it runs at most once.
        if (layer.group && ranGroups?.has(layer.group)) continue;

        if (layer.kind === "end") {
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

          if (optionsMethods && !layer.methods.includes(HTTP_METHODS.OPTIONS) && routeMatchesPath(layer, req.path, pathLayers!, this.caseSensitive)) {
            const router = layer.routers[layer.routers.length - 1];
            if (!optionsMethods.has(router)) optionsMethods.set(router, new Set());
            const methods = optionsMethods.get(router)!;
            for (const name of layer.methods) methods.add(name.toUpperCase());
            if (layer.methods.includes(HTTP_METHODS.GET)) methods.add("HEAD");
            continue;
          }

          let params: Record<string, string>;
          if (layer.pattern) {
            if (!handlesMethod(layer, method)) continue;
            let found: PatternMatch | null;
            try {
              found = matchPattern(layer.pattern, relativePath(req.path, layer.fullPath, this.caseSensitive));
            } catch (error) {
              err = error;
              continue;
            }
            if (!found) continue;
            params = found.params;
          } else {
            // Only matched route layers are in the order, plus, for OPTIONS,
            // the path's other routes, which were handled above.
            if (matchedLayers && !matchedLayers.has(layer)) continue;
            params = pickParams(match!.params, layer.keys);
          }

          if (layer.group) (ranGroups ??= new Set()).add(layer.group);
          current = layer;
          return this.runRoute(req, res, layer, params, method, getParamCalls, next);
        }

        if (!matchesPrefix(req.path, layer.path, this.caseSensitive)) continue;

        let mounted: PatternMatch | null = null;
        try {
          if (layer.pattern) {
            mounted = matchMount(layer.pattern, relativePath(req.path, layer.path, this.caseSensitive));
            if (!mounted) continue;
          } else if (layer.keys.length > 0) {
            mounted = { params: pickParams(mountParams(req.path, layer.path, this.caseSensitive), layer.keys), path: "" };
          }
        } catch (error) {
          err = err || error;
          continue;
        }

        const isErrorHandler = layer.handle.length === 4;
        if (Boolean(err) !== isErrorHandler) continue;

        if (layer.group) (ranGroups ??= new Set()).add(layer.group);
        current = layer;
        return this.callMiddleware(req, res, layer, err, next, mounted, getParamCalls);
      }

      if (!err && routerDone(this.router)) return;

      this.finalHandler(req, res, err);
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
      this.settings["query parser fn"](queryStart === -1 ? null : url.slice(queryStart + 1));
    req.baseUrl = "";
    req.params = {};
    res.locals = res.locals || {};
    if (this.settings["x-powered-by"]) res.setHeader("X-Powered-By", "Pype");

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

      mount(req, layer.path, this.caseSensitive);
      if (mounted) mount(req, mounted.path);

      const done = once((error?: any) => {
        req.url = url;
        req.path = path;
        req.baseUrl = baseUrl;
        next(error);
      });

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
    layer: RouteLayer | MiddlewareLayer,
    params: Record<string, string>,
    keys: string[],
    requestPath: string,
    getParamCalls: () => Map<PypeRouter, Record<string, ParamCall>>,
    done: (err?: any) => void,
  ) {
    const runCallbacks = (router: PypeRouter, names: string[], next: (err?: any) => void) => {
      if (names.length === 0 || !router.hasParams) return next();
      const paramCalls = getParamCalls();
      let calls = paramCalls.get(router);
      if (!calls) paramCalls.set(router, (calls = Object.create(null) as Record<string, ParamCall>));
      processParams(router.params, names, calls, req, res, next);
    };

    // Callbacks may change req.params, the next router down inherits that.
    let parent: Record<string, string> | undefined;
    let level = 0;
    const enter = (error?: any): void => {
      if (error) return done(error);
      if (level < layer.mounts.length) {
        const scope = layer.mounts[level++];
        // Each mount path's own segments, so a name used at two levels keeps both values.
        let own: Record<string, string> = {};
        try {
          if (scope.keys.length > 0) own = pickParams(mountParams(requestPath, scope.path, this.caseSensitive), scope.keys);
        } catch (decodeError) {
          return done(decodeError);
        }
        req.params = parent = mergeParams(scope.router.mergeParams, own, parent);
        return runCallbacks(scope.router, scope.keys, enter);
      }
      const router = layer.routers[layer.routers.length - 1];
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
    method: string,
    getParamCalls: () => Map<PypeRouter, Record<string, ParamCall>>,
    next: (err?: any) => void,
  ) {
    const { url, path, baseUrl } = req;
    req.route = { path: layer.routePath, method };
    mount(req, layer.baseUrl, this.caseSensitive);

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

    const keys = layer.pattern ? Object.keys(params) : layer.keys;
    this.enterParams(req, res, layer, params, keys, path, getParamCalls, (error) =>
      error ? leave(error) : routeNext(),
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
      // Unlike Express, the extra call doesn't run more layers; an error it
      // carries is still printed so it isn't lost.
      if (err && err !== "route" && err !== "router") {
        console.warn("[warn]: next() called multiple times, ignoring the error passed to it:", err);
      } else {
        console.warn("[warn]: next() called multiple times");
      }
      return;
    }
    called = true;
    fn(err);
  };
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
 * @throws A 400 error when a param has a malformed escape.
 */
function matchPattern(pattern: RegExp, path: string): PatternMatch | null {
  const match = pattern.exec(path);
  if (!match) return null;

  const keys = keysOf(pattern);
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
function matchMount(pattern: RegExp, path: string): PatternMatch | null {
  const match = matchPattern(pattern, path);
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
function relativePath(path: string, mountPath: string, caseSensitive: boolean) {
  return path.slice((matchedPrefix(path, mountPath, caseSensitive) ?? normalizeBase(mountPath)).length) || "/";
}

/** Whether a route's path matches the request, whatever the method; for automatic OPTIONS. */
function routeMatchesPath(layer: RouteLayer, path: string, treeLayers: Set<RouteLayer>, caseSensitive: boolean) {
  if (!layer.pattern) return treeLayers.has(layer);
  try {
    return matchPattern(layer.pattern, relativePath(path, layer.fullPath, caseSensitive)) !== null;
  } catch {
    return false;
  }
}

/** Whether a route handles a method, HEAD falling back to GET like Express. */
function handlesMethod(layer: RouteLayer, method: string) {
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
  if (typeof value === "function") {
    // Like Express, a custom function always gets the body as a Buffer.
    const custom = value as (body: Buffer, encoding?: BufferEncoding) => string | undefined;
    return (body) => custom(typeof body === "string" ? Buffer.from(body) : body, undefined);
  }
  switch (value) {
    case true:
    case "weak":
      return (body) => generateETag(body);
    case "strong":
      return (body) => generateStrongETag(body);
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
  return base.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** `/some` matches `/some` and `/some/...`, but not `/something`. */
function matchesPrefix(requestPath: string, prefix: string, caseSensitive: boolean) {
  return matchedPrefix(requestPath, prefix, caseSensitive) !== null;
}

/**
 * The start of `requestPath` that a mount path matches, compared segment by
 * segment so that a `:param` segment matches any one segment: `/r/:org`
 * matches `/r/acme/42` as `/r/acme`. `null` when it doesn't match.
 *
 * @param caseSensitive - `false` ignores ASCII case. The result is always
 * the request's own text, so `req.baseUrl` keeps its case like in Express.
 */
function matchedPrefix(requestPath: string, prefix: string, caseSensitive = true): string | null {
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

/**
 * The `:param` values of a mount path like `/orgs/:org`, URL-decoded.
 *
 * @throws A 400 error when a param has a malformed escape.
 */
function mountParams(requestPath: string, mountPath: string, caseSensitive: boolean): Record<string, string> {
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
  return enabled && parent ? { ...parent, ...params } : params;
}

/** Strips `base` from the front of `req.url` and `req.path` and appends it to `req.baseUrl`. */
function mount(req: Request, base: string, caseSensitive = true) {
  const prefix = matchedPrefix(req.path, base, caseSensitive) ?? normalizeBase(base);
  if (!prefix) return;

  req.baseUrl = normalizeBase(req.baseUrl + prefix);
  req.path = req.path.slice(prefix.length) || "/";

  const url = req.url || "/";
  const rest = url.slice(prefix.length);
  req.url = rest.startsWith("?") || rest === "" ? `/${rest}` : rest;
}
