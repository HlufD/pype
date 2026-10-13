// Express-compatible: next() continues, next(err) jumps to error middleware,
// next("route") skips the rest of the current route's handlers and
// next("router") leaves the current router.
export type NextFunction = (err?: any) => void;
