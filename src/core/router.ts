import { HTTP_METHODS } from "../enums/methods.enum";
import { Middleware } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";
import { Router } from "../types/router";
import { RouteNode } from "../utils/Trie-Route";

class RouteBuilder {
  constructor(
    private path: string,
    private router: PipeRouter,
  ) {
    this.path = path;
    this.router = router;
  }
  get(routeHandler: RouteHandler) {
    this.router.get(this.path, routeHandler);
    return this;
  }

  post(routeHandler: RouteHandler) {
    this.router.post(this.path, routeHandler);
    return this;
  }

  put(routeHandler: RouteHandler) {
    this.router.put(this.path, routeHandler);
    return this;
  }

  delete(routeHandler: RouteHandler) {
    this.router.delete(this.path, routeHandler);
    return this;
  }

  patch(routeHandler: RouteHandler) {
    this.router.patch(this.path, routeHandler);
    return this;
  }
}

export class PipeRouter implements Router {
  private router = new RouteNode({
    ignoreDuplicateSlashes: false,
    ignoreTrailingSlash: false,
  });

  globalMiddlewares: Middleware[] = [];

  get(url: string, routeHandler: RouteHandler): void {
    this.router.register(url, HTTP_METHODS.GET, [routeHandler]);
  }

  post(url: string, routeHandler: RouteHandler): void {
    this.router.register(url, HTTP_METHODS.POST, [routeHandler]);
  }

  put(url: string, routeHandler: RouteHandler): void {
    this.router.register(url, HTTP_METHODS.PUT, [routeHandler]);
  }

  delete(url: string, routeHandler: RouteHandler): void {
    this.router.register(url, HTTP_METHODS.DELETE, [routeHandler]);
  }

  patch(url: string, routeHandler: RouteHandler): void {
    this.router.register(url, HTTP_METHODS.PATCH, [routeHandler]);
  }

  match(method: HTTP_METHODS, path: string) {
    const match = this.router.match(path, method);

    if (!match) return null;

    const { params, handlers } = match;

    const chain = [...this.globalMiddlewares, ...handlers];

    return { handlers: chain, params: params };
  }

  use(middleware: Middleware) {
    this.globalMiddlewares.push(middleware);
  }

  route(path: string) {
    return new RouteBuilder(path, this);
  }
}
