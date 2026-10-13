import { HTTP_METHODS } from "../enums/methods.enum";
import { Middleware } from "./middleware";
import { RouteHandler } from "./route-handler";

/** Shape of the original router API. No longer used since the router rewrite. */
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

/** A single route with one handler. No longer used. */
interface Routes {
  method: string;
  path: string;
  handler: RouteHandler;
}

/** A route collected from a router. No longer used. */
interface RouteDefinition {
  method: HTTP_METHODS;
  handlers: RouteHandler[];
  path: string;
  /** The path as written in the router, set by `collectRoutes`. */
  routePath?: string;
  /** Where the router is mounted, set by `collectRoutes`. */
  baseUrl?: string;
}
