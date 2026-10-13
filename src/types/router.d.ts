import { HTTP_METHODS } from "../enums/methods.enum";
import { Middleware } from "./middleware";
import { RouteHandler } from "./route-handler";

interface Router {
  get(url: String, routHandler: RouteHandler): void;

  post(url: String, routHandler: RouteHandler): void;

  put(url: String, routHandler: RouteHandler): void;

  delete(url: String, routHandler: RouteHandler): void;

  patch(url: String, routHandler: RouteHandler): void;

  use(path: string, router: Router): void;

  route(path: string, router: Router);

  collectRoutes(router: Router, basePath?: string): RouteDefinition[];
}

interface Routes {
  method: string;
  path: string;
  handler: RouteHandler;
}

interface RouteDefinition {
  method: HTTP_METHODS;
  handlers: RouteHandler[];
  path: string;
  // Set by collectRoutes: the path as written in the router, and where the
  // router is mounted.
  routePath?: string;
  baseUrl?: string;
}
