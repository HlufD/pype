import { Middleware } from "./middleware";

/** Handler registered on a route, same signature as middleware. */
type RouteHandler = Middleware;
