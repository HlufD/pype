import { IncomingMessage, ServerResponse, createServer } from "http";
import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { RouteNode } from "../utils/Trie-Route";
import { PipeRouter } from "./router";
import { Request } from "./request";
import { Response } from "./response";
import { Middleware, NextFunction } from "../types/middleware";

export class PipeServer {
  routes: RouteNode;
  middlewares: Middleware[];

  constructor() {
    this.routes = new RouteNode({
      ignoreDuplicateSlashes: true,
      ignoreTrailingSlash: true,
    });

    this.middlewares = [];
  }

  public listen(port: number, callback?: () => void) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res);
    });
    server.listen(port, callback);
  }

  private handleRequest(
    rawRequest: IncomingMessage,
    rawResponse: ServerResponse,
  ) {
    const request = new Request(rawRequest);
    const response = new Response(rawResponse);

    const method = request.method;
    const url = request.url;
    const route = this.routes.match(url, method.toLowerCase() as HTTP_METHODS);

    if (!route) {
      return response.status(404).json({ error: "Not Found", status: 404 });
    }

    let { handlers, params } = route;
    request.params = params;

    this.executeMiddlewareChain(request, response, [
      ...this.middlewares,
      ...handlers,
    ]);
  }

  public executeMiddlewareChain(
    req: Request,
    res: Response,
    handlers: RouteHandler[] | Middleware[],
  ) {
    let start = 0;
    const next = () => {
      if (res.raw.writableEnded) return;

      const result = handlers[start++](req, res, next);

      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.log(`[error]:`, error);
          return res
            .status(500)
            .json({ error: "Internal server error", status: 500 });
        });
      }
    };

    next();
  }

  public use(arg1: string | Middleware, arg2?: PipeRouter | Middleware) {
    if (typeof arg1 === "function") {
      this.middlewares.push(arg1);
      return;
    }

    if (typeof arg1 === "string" && typeof arg2 === "function") {
      const path = arg1;
      const handler = arg2;

      this.middlewares.push(
        (req: Request, res: Response, next: NextFunction) => {
          if (req.url.startsWith(path)) return handler(req, res, next);
          else next();
        },
      );

      return;
    }

    if (typeof arg1 === "string" && arg2 instanceof PipeRouter) {
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
