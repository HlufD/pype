/**
 * Express-compatible continuation function.
 *
 * - `next()` continues with the next matching layer.
 * - `next(err)` skips to the next error-handling middleware.
 * - `next("route")` skips the rest of the current route's handlers.
 * - `next("router")` leaves the current router.
 */
export type NextFunction = (err?: any) => void;
