import type { NextFunction } from "./next-function";
import type { Request } from "./request";
import type { Response } from "./response";

/**
 * Regular middleware or route handler.
 *
 * @param req - The incoming request.
 * @param res - The outgoing response.
 * @param next - Passes control to the next matching layer.
 */
export type Middleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Error-handling middleware, recognised by having exactly four parameters.
 *
 * @param err - The error passed to `next(err)` or thrown by a handler.
 */
export type ErrorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Accepts handlers typed against other frameworks' request/response types,
 * such as Express middleware from npm.
 */
export type AnyHandler = (...args: any[]) => unknown;
