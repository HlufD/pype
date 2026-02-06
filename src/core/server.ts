import { IncomingMessage, ServerResponse, createServer } from "http";
import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { RouteNode } from "../utils/Trie-Route";
import { PipeRouter } from "./router";
import { Request } from "../types/request";
import { Response } from "../types/response";

export class PipeServer {
  routes: RouteNode;
  constructor() {
    this.routes = new RouteNode({});
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

    const method = rawRequest.method as HTTP_METHODS;
    const url = rawRequest.url || "/";
    const route = this.routes.match(url, method);

    if (!route) {
      return;
    }

    const { handlers, params } = route;
    request.params = params;

    for (const handler of handlers) {
      handler(request, response);
    }
  }

  public use(path: string, router: PipeRouter) {
    const routes = router.collectRoutes(router, path);
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      this.routes.register(route.path, route.method, route.handlers);
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
