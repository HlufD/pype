import { createServer } from "node:http";
import { PipeRouter } from "./router";
import { HTTP_METHODS } from "../enums/methods.enum";
import { Request } from "../types/request";
import { Response } from "../types/response";
import { Middleware, NextFunction } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";
export class PipeServer {
  private router: PipeRouter;

  constructor() {
    this.router = new PipeRouter();
  }

  public listen(port: number, callback?: () => void) {
    const server = createServer(this.handleRequest.bind(this));
    server.listen(port, callback);
  }

  private handleRequest(req: Request, res: Response) {
    const method = req.method;
    const path = req.url?.split("?")[0] ?? "/";

    const matchedRoute = this.router.match(
      method?.toLowerCase() as HTTP_METHODS,
      path,
    );

    if (!matchedRoute) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("Not Found");
      return;
    }

    this.runHandlerChains(matchedRoute.handlers as RouteHandler[], req, res);
  }

  private runHandlerChains(
    handlers: RouteHandler[],
    req: Request,
    res: Response,
  ) {
    let startIndex = 0;
    const next: NextFunction = () => {
      if (res.writableEnded) return;
      const handler = handlers[startIndex++];
      if (!handler) return;

      try {
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.catch((error) => this.handleError(error, res));
        }
      } catch (error: unknown) {
        this.handleError(error, res);
      }
    };

    next();
  }

  private handleError(err: unknown, res: Response) {
    if (res.writableEnded) return;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end("Internal server error.");
  }

  // router methods

  get(url: string, routeHandler: RouteHandler) {
    this.router.get(url, routeHandler);
    return this;
  }

  post(url: string, routeHandler: RouteHandler) {
    this.router.post(url, routeHandler);
    return this;
  }

  delete(url: string, routeHandler: RouteHandler) {
    this.router.delete(url, routeHandler);
    return this;
  }

  patch(url: string, routeHandler: RouteHandler) {
    this.router.patch(url, routeHandler);
    return this;
  }

  put(url: string, routeHandler: RouteHandler) {
    this.router.put(url, routeHandler);
    return this;
  }

  use(middleware: Middleware) {
    this.router.use(middleware);
    return this;
  }

  route(url: string) {
    return this.router.route(url);
  }
}
