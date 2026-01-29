import { HTTP_METHODS } from "../enums/methods.enum";
import { Middleware } from "../types/middleware";
import { RouteHandler } from "../types/route-handler";
import { Router } from "../types/router";
import { RouteNode } from "../utils/Trie-Route";

export class PipeRouter implements Router {
  get(url: String, routHandler: RouteHandler): void {
    throw new Error("Method not implemented.");
  }
  post(url: String, routHandler: RouteHandler): void {
    throw new Error("Method not implemented.");
  }
  put(url: String, routHandler: RouteHandler): void {
    throw new Error("Method not implemented.");
  }
  delete(url: String, routHandler: RouteHandler): void {
    throw new Error("Method not implemented.");
  }
  patch(url: String, routHandler: RouteHandler): void {
    throw new Error("Method not implemented.");
  }
}
