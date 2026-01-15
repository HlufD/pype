import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { Router, Routes } from "../types/router";
import { Trie } from "../utils/trie";


export class PipeRouter implements Router {

    private routes = new Trie()

    get(url: string, routeHandler: RouteHandler): void {
        this.routes.register(url, HTTP_METHODS.GET, routeHandler);
    }

    post(url: string, routeHandler: RouteHandler): void {
        this.routes.register(url, HTTP_METHODS.POST, routeHandler);
    }

    put(url: string, routeHandler: RouteHandler): void {
        this.routes.register(url, HTTP_METHODS.PUT, routeHandler);
    }

    delete(url: string, routeHandler: RouteHandler): void {
        this.routes.register(url, HTTP_METHODS.DELETE, routeHandler);
    }

    patch(url: string, routeHandler: RouteHandler): void {
        this.routes.register(url, HTTP_METHODS.PATCH, routeHandler);
    }

    match(method: HTTP_METHODS, path: string) {
        return this.routes.match(path, method)
    }
}