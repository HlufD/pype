import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { Router } from "../types/router";
import { RouteNode } from "../utils/Trie-Route";

export class PipeRouter implements Router {
  private router = new RouteNode({
    ignoreDuplicateSlashes: false,
    ignoreTrailingSlash: false,
  });

  globalMiddlewares: RouteHandler[] = [];

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

  use(middleware: RouteHandler) {
    this.globalMiddlewares.push(middleware);
  }
}
