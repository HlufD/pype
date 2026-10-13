import { NextFunction } from "./next-function";
import { Request } from "./request";
import { Response } from "./response";

type Middleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

// Error middleware is recognised by having exactly four parameters.
type ErrorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

// Accepts handlers typed against other frameworks' request/response types,
// such as Express middleware from npm.
type AnyHandler = (...args: any[]) => unknown;
