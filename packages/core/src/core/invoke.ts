import { AnyHandler } from "../types/middleware";
import type { Request } from "./request";
import type { Response } from "./response";

/**
 * Calling handlers the way Express does, shared by the app's pipeline and
 * {@link Route.dispatch}.
 */

/**
 * Calls a handler (or error handler), routing throws and rejected promises
 * to `next(err)` like Express 5.
 */
export function invoke(
  handler: AnyHandler,
  err: any,
  req: Request,
  res: Response,
  next: (err?: any) => void,
) {
  try {
    const result: any = err
      ? handler(err, req, res, next)
      : handler(req, res, next);

    if (result && typeof result.then === "function") {
      result.then(undefined, (error: unknown) =>
        next(error ?? new Error("Rejected promise")),
      );
    }
  } catch (error) {
    next(error);
  }
}

/** Wraps `next` so calling it again only logs a warning. */
export function once(fn: (err?: any) => void) {
  let called = false;
  return (err?: any) => {
    if (called) {
      // Unlike Express, the extra call doesn't run more layers; an error it
      // carries is still printed so it isn't lost.
      if (err && err !== "route" && err !== "router") {
        console.warn("[warn]: next() called multiple times, ignoring the error passed to it:", err);
      } else {
        console.warn("[warn]: next() called multiple times");
      }
      return;
    }
    called = true;
    fn(err);
  };
}
