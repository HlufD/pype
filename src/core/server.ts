import {
  IncomingMessage,
  STATUS_CODES,
  ServerResponse,
  createServer,
} from "http";
import { HTTP_METHODS } from "../enums/methods.enum";
import { RouteHandler } from "../types/route-handler";
import { RouteNode } from "../utils/Trie-Route";
import { PypeRouter } from "./router";
import { NextFunction } from "../types/next-function";
import { Middleware } from "../types/middleware";
import { Request } from "../types/request";
import { Response } from "../types/response";
import { MIME_TYPES } from "../enums/mime-types";

export class Pype {
  routes: RouteNode;
  pypeMiddlewares: Middleware[];

  constructor() {
    this.routes = new RouteNode({
      ignoreDuplicateSlashes: true,
      ignoreTrailingSlash: true,
    });

    this.pypeMiddlewares = [];
  }

  public listen(port: number, callback?: () => void) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const request = this.decorateRequest(req as Request);
      const response = this.decorateResponse(res as Response);
      this.handleRequest(request, response);
    });
    server.listen(port, callback);
  }

  private handleRequest(request: Request, response: Response) {
    const method = request.method || HTTP_METHODS.HEAD;
    const url = request.url || "/";
    const route = this.routes.match(url, method.toLowerCase() as HTTP_METHODS);

    if (!route) {
      return response.status(404).json({ error: "Not Found", status: 404 });
    }

    let { handlers, params } = route;
    request.params = params;

    this.executeMiddlewareChain(request, response, [
      ...this.pypeMiddlewares,
      ...handlers,
    ]);
  }

  public executeMiddlewareChain(
    req: Request,
    res: Response,
    handlers: RouteHandler[] | Middleware[],
  ) {
    let start = 0;
    const next = () => {
      if (res.writableEnded) return;

      const result = handlers[start++](req, res, next);

      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.log(`[error]:`, error);
          return res
            .status(500)
            .json({ error: "Internal server error", status: 500 });
        });
      }
    };

    next();
  }

  public use(arg1: string | Middleware, arg2?: PypeRouter | Middleware) {
    if (typeof arg1 === "function") {
      this.pypeMiddlewares.push(arg1);
      return;
    }

    if (typeof arg1 === "string" && typeof arg2 === "function") {
      const path = arg1;
      const handler = arg2;

      this.pypeMiddlewares.push(
        (req: Request, res: Response, next: NextFunction) => {
          if (req.url!.startsWith(path)) return handler(req, res, next);
          else next();
        },
      );

      return;
    }

    if (typeof arg1 === "string" && arg2 instanceof PypeRouter) {
      const path = arg1;
      const router = arg2;
      const routes = router.collectRoutes(router, path);
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        this.routes.register(route.path, route.method, route.handlers);
      }
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

  private decorateRequest(req: Request) {
    req.params = {};
    req.query = {};

    req.get = function (header: string): string | string[] | undefined {
      return this.headers[header.toLowerCase()];
    };

    return req;
  }

  private decorateResponse(res: Response) {
    res.status = function (code: number) {
      this.statusCode = code;
      return this;
    };

    res.sendStatus = function (code: number) {
      this.status(code);
      this.type("txt");
      this.send(STATUS_CODES[code] || String(code));
      return this;
    };

    res.send = function (body?: any) {
      if (this.writableEnded) return this;

      if (Buffer.isBuffer(body)) {
        if (!this.getHeader("Content-Type")) {
          this.setHeader("Content-Type", "application/octet-stream");
        }
      } else if (typeof body === "object" && body !== null) {
        if (!this.getHeader("Content-Type")) {
          this.setHeader("Content-Type", "application/json; charset=utf-8");
        }
        body = JSON.stringify(body);
      } else if (typeof body === "number") {
        this.statusCode = body;
        body = String(body);
        if (!this.getHeader("Content-Type")) {
          this.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
      } else if (typeof body === "string") {
        if (!this.getHeader("Content-Type")) {
          this.setHeader("Content-Type", "text/html; charset=utf-8");
        }
      }

      if (!this.getHeader("Content-Length") && body != null) {
        const length =
          typeof body === "string"
            ? Buffer.byteLength(body)
            : Buffer.isBuffer(body)
              ? body.length
              : 0;

        if (length > 0) {
          this.setHeader("Content-Length", length.toString());
        }
      }

      this.end(body);
      return this;
    };

    res.json = function (data: Record<string, any>) {
      if (!this.getHeader("Content-Type"))
        this.setHeader("Content-Type", "application/json; charset=utf-8");

      this.send(data);
      return this;
    };

    res.get = function (field: string) {
      return this.getHeader(field);
    };

    res.set = function (
      field: string | Record<string, string>,
      value?: string,
    ) {
      if (typeof field === "string") {
        if (value === undefined)
          throw new Error("Value is required when field is a string");

        this.setHeader(field, value);
      } else {
        for (const key in field) {
          this.setHeader(key, field[key]);
        }
      }
      return this;
    };

    res.type = function (value: string) {
      if (!value) return this;

      let type = value.trim().toLowerCase();

      if (type.includes("/")) {
        this.setHeader("Content-Type", type);
        return this;
      }

      type = type.replace(/^\./, "");

      const mimeType = MIME_TYPES[type];

      let finalType = mimeType || "application/octet-stream";

      if (finalType.startsWith("text/") && !finalType.includes("charset")) {
        finalType += "; charset=utf-8";
      }

      this.setHeader("Content-Type", finalType);
      return this;
    };

    res.redirect = function (location: string) {
      if (!location || this.writableEnded) return this;

      this.status(302);
      this.set("Location", location);

      if (!this.get("Content-Type"))
        this.set("Content-Type", "text/plain; charset=utf-8");

      this.end(`Found. Redirecting to ${location}`);

      return this;
    };

    res.links = function (links: Record<string, string>) {
      if (!links || typeof links !== "object") {
        return this;
      }

      const existing = this.getHeader("Link");
      const linkValues: string[] = [];

      for (const rel in links) {
        const url = links[rel];

        if (typeof url !== "string") continue;

        linkValues.push(`<${url}>; rel="${rel}"`);
      }

      const newValue = linkValues.join(", ");

      if (existing) {
        this.setHeader("Link", `${existing}, ${newValue}`);
      } else {
        this.setHeader("Link", newValue);
      }

      return this;
    };

    res.location = function (location: string) {
      this.set("Location", location);
      return this;
    };

    res.cookie = function () {
      return this;
    };

    res.clearCookie = function () {
      return this;
    };

    return res;
  }
}
