import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { Router, Routes } from "../types/router";


export class PipeRouter implements Router {

    private routes: Routes[] = []

    get(url: string, routeHandler: RouteHandler): void {
        this.register(url, HTTP_METHODS.GET, routeHandler);
    }

    post(url: string, routeHandler: RouteHandler): void {
        this.register(url, HTTP_METHODS.POST, routeHandler);
    }

    put(url: string, routeHandler: RouteHandler): void {
        this.register(url, HTTP_METHODS.PUT, routeHandler);
    }

    delete(url: string, routeHandler: RouteHandler): void {
        this.register(url, HTTP_METHODS.DELETE, routeHandler);
    }

    patch(url: string, routeHandler: RouteHandler): void {
        this.register(url, HTTP_METHODS.PATCH, routeHandler);
    }

    private register(url: string, method: HTTP_METHODS, routeHandler: RouteHandler) {
        this.routes.push({ path: url, method, handler: routeHandler })
    }

    match(method: string, path: string) {
        return this.routes.find(
            route => route.method.toLowerCase() === method.toLowerCase() && route.path === path
        );
    }
}