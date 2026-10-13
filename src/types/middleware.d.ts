import { NextFunction } from "./next-function";
import { Request } from "./request";
import { Response } from "./response";

/**
 * Regular middleware or route handler.
 *
 * @param req - The incoming request.
 * @param res - The outgoing response.
 * @param next - Passes control to the next matching layer.
 */
type Middleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Error-handling middleware, recognised by having exactly four parameters.
 *
 * @param err - The error passed to `next(err)` or thrown by a handler.
 */
type ErrorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Accepts handlers typed against other frameworks' request/response types,
 * such as Express middleware from npm.
 */
type AnyHandler = (...args: any[]) => unknown;
