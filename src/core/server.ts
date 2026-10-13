import { createServer } from "http";
import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { RouteNode } from "../utils/Trie-Route";
import { PypeRouter } from "./router";
import { NextFunction } from "../types/next-function";
import { Middleware } from "../types/middleware";
import { Request } from "./request";
import { Response } from "./response";

export class Pype {
  routes: RouteNode;
  pypeMiddlewares: Middleware[];

  constructor() {
    this.routes = new RouteNode({
      ignoreDuplicateSlashes: true,
      ignoreTrailingSlash: true,
    });

    this.pypeMiddlewares = [];
  }

  public listen(port: number, callback?: () => void) {
    const server = createServer(
      { IncomingMessage: Request, ServerResponse: Response },
      (req, res) => {
        req.res = res;
        this.handleRequest(req, res);
      },
    );
    return server.listen(port, callback);
  }

  private handleRequest(request: Request, response: Response) {
    const method = (request.method || HTTP_METHODS.GET).toLowerCase();
    const url = request.url || "/";
    const queryStart = url.indexOf("?");
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    const search = queryStart === -1 ? "" : url.slice(queryStart + 1);

    request.path = path;
    request.query = parseQuery(search);

    const route = this.routes.match(path, method as HTTP_METHODS);
    if (route) request.params = route.params;

    this.executeMiddlewareChain(request, response, [
      ...this.pypeMiddlewares,
      ...(route ? route.handlers : []),
    ]);
  }

  public executeMiddlewareChain(
    req: Request,
    res: Response,
    handlers: RouteHandler[] | Middleware[],
  ) {
    const dispatch = (index: number) => {
      if (res.writableEnded) return;

      const handler = handlers[index];
      if (!handler) {
        res.status(404).json({ error: "Not Found", status: 404 });
        return;
      }

      let called = false;
      const next = () => {
        if (called) {
          console.warn("[warn]: next() called multiple times");
          return;
        }
        called = true;
        dispatch(index + 1);
      };

      try {
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.handleError(error, res));
        }
      } catch (error) {
        this.handleError(error, res);
      }
    };

    dispatch(0);
  }

  private handleError(error: unknown, res: Response) {
    console.log(`[error]:`, error);

    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }

    res.status(500).json({ error: "Internal server error", status: 500 });
  }

  public use(arg1: string | Middleware, arg2?: PypeRouter | Middleware) {
    if (typeof arg1 === "function") {
      this.pypeMiddlewares.push(arg1);
      return;
    }

    if (typeof arg1 === "string" && typeof arg2 === "function") {
      const path = arg1;
      const handler = arg2;

      this.pypeMiddlewares.push(
        (req: Request, res: Response, next: NextFunction) => {
          if (matchesPrefix(req.path, path)) return handler(req, res, next);
          else next();
        },
      );

      return;
    }

    if (typeof arg1 === "string" && arg2 instanceof PypeRouter) {
      const path = arg1;
      const router = arg2;
      const routes = router.collectRoutes(router, path);
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        this.routes.register(route.path, route.method, route.handlers);
      }
    }
  }

  public get(path: string, handlers: RouteHandler[] | RouteHandler) {
    handlers = this.changeToArray(handlers);
    this.routes.register(path, HTTP_METHODS.GET, handlers);
  }

  public post(path: string, handlers: RouteHandler[] | RouteHandler) {
    handlers = this.changeToArray(handlers);
    this.routes.register(path, HTTP_METHODS.POST, handlers);
  }

  public patch(path: string, handlers: RouteHandler[] | RouteHandler) {
    handlers = this.changeToArray(handlers);
    this.routes.register(path, HTTP_METHODS.PATCH, handlers);
  }

  public put(path: string, handlers: RouteHandler[] | RouteHandler) {
    handlers = this.changeToArray(handlers);
    this.routes.register(path, HTTP_METHODS.PUT, handlers);
  }

  public delete(path: string, handlers: RouteHandler[] | RouteHandler) {
    handlers = this.changeToArray(handlers);
    this.routes.register(path, HTTP_METHODS.DELETE, handlers);
  }

  private changeToArray(
    handlers: RouteHandler[] | RouteHandler,
  ): RouteHandler[] {
    if (!Array.isArray(handlers)) {
      handlers = [handlers];
    }
    return handlers;
  }
}

function parseQuery(search: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};

  for (const [key, value] of new URLSearchParams(search)) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }

  return query;
}

// "/some" matches "/some" and "/some/...", but not "/something".
function matchesPrefix(requestPath: string, prefix: string) {
  const base = prefix.replace(/\/+$/, "");
  if (base === "") return true;
  return requestPath === base || requestPath.startsWith(base + "/");
}
