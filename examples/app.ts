/**
 * Example API: `npm run dev`, then try `curl localhost:3000/api/users/1`.
 *
 * Shows routers, body parsing, route params, error middleware, a JSON 404
 * and graceful shutdown.
 *
 * @packageDocumentation
 */
import { json, NextFunction, Pype, PypeRouter, Request, Response } from "../src";

/** In-memory data store for the example. */
const users = new Map([
  [1, { id: 1, name: "Ada" }],
  [2, { id: 2, name: "Linus" }],
]);

/** Error with an HTTP status, picked up by the error middleware. */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const app = new Pype();
const api = new PypeRouter();

app.use(json());

app.use((req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

api.get("/users", (_req: Request, res: Response) => {
  res.json([...users.values()]);
});

api.get("/users/:id", (req: Request, res: Response) => {
  const user = users.get(Number(req.params.id));
  if (!user) throw new HttpError(404, `User ${req.params.id} not found`);
  res.json(user);
});

api.post("/users", (req: Request, res: Response) => {
  if (typeof req.body?.name !== "string") throw new HttpError(400, "name is required");

  const user = { id: users.size + 1, name: req.body.name };
  users.set(user.id, user);
  res.status(201).location(`/api/users/${user.id}`).json(user);
});

app.use("/api", api);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: status < 500 ? err.message : "Internal Server Error" });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`listening on http://localhost:${port}`);
});

/** Stops accepting connections and exits once in-flight requests finish. */
function shutdown() {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
