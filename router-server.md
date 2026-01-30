# PipeServer & PipeRouter – Route Modularization

## Concept

PipeServer uses a **trie-based router** internally to efficiently match routes. To support modularization, we separate the **definition of routes** from their **registration into the trie**. This allows:

- **Modular routers**: groups of routes can be defined independently and mounted anywhere in the app.
- **Route prefixes**: routers can be mounted under a path prefix (e.g., `/users`) without rewriting individual routes.
- **Scoped middleware**: middlewares can be associated with a router, and apply to all its routes.
- **Lazy registration**: routes defined in routers are not immediately registered to the trie. Registration happens only when a router is mounted to the server.
- **Express-compatible middleware**: any middleware designed for Express (signature `(req, res, next)`) works seamlessly.

---

## Specification

### 1. PipeRouter (Passive)

- **Responsibilities**:
  - Store route definitions (`method`, `path`, `handlers`) without registering to the trie.
  - Store router-specific middlewares.
  - Support `.get()`, `.post()`, `.put()`, `.delete()`, `.patch()` methods.
  - Support `.route(path)` for chaining multiple methods.
  - Support `.use(middleware)` to attach middleware to the router (applies to all its routes).

- **Data structures**:
  - `routes: RouteDefinition[]` – list of route definitions.
  - `middlewares: Middleware[]` – router-level middlewares.

- **Behavior**:
  - Routes become “active” only when mounted to a server.
  - Middleware order is preserved exactly as added:
    1. Global middlewares (server-level)
    2. Router-level middlewares (per mounted router)
    3. Route-specific middlewares/handlers

  - Middleware function signature is the same as Express `(req, res, next)` for compatibility.

---

### 2. PipeServer (Active)

- **Responsibilities**:
  - Owns the `RouteNode` (trie) for all registered routes.
  - Matches incoming requests to the correct route handlers efficiently.
  - Executes middlewares and route handlers in the correct order.
  - Mounts routers with optional path prefixes.

- **Behavior**:
  - `use(routerOrPrefix: string | PipeRouter, maybeRouter?: PipeRouter)`:
    - If given a router, register its routes at `/`.
    - If given a prefix and router, register all router routes under that prefix.
    - Copy router middlewares and associate with the prefix if needed.

  - Nested routers are supported naturally.
  - Middleware execution order is preserved, so Express-compatible middleware works as expected.

---

### 3. Route Matching

- Requests are matched against the **trie** for O(n) path matching.
- Supports parameters (`:id`), optional segments (`:id?`), and wildcards (`*`).
- Middleware chaining happens in this order:
  1. Global server middlewares
  2. Router-level middlewares (for the mounted router/prefix)
  3. Route-specific middlewares/handlers

---

### 4. Middleware Compatibility

- Middleware functions follow the Express convention:

```ts
(req: Request, res: Response, next: NextFunction) => void
```

- Supports synchronous and asynchronous middlewares.
- Use `next()` to continue the chain, or `next(err)` / `throw` to signal errors.
- Order is preserved exactly like Express.

---

### 5. Example Usage

#### 5.1 Global and Router-Level Middleware

```ts
// Global middleware
server.use((req, res, next) => {
  console.log("Global middleware");
  next();
});

// Router-level middleware
const usersRouter = new PipeRouter();
usersRouter.use((req, res, next) => {
  console.log("Users router middleware");
  next();
});

// Routes
usersRouter.get("/", (req, res) => res.end("User list"));
usersRouter.get("/:id", (req, res) => res.end(`User ${req.params.id}`));

// Mount router
server.use("/users", usersRouter);

// Request flow for GET /users:
// 1. Global middleware
// 2. Users router middleware
// 3. Route handler
```

#### 5.2 Route Chaining with `.route()`

```ts
const postsRouter = new PipeRouter();

postsRouter
  .route("/")
  .get((req, res) => res.end("Get all posts"))
  .post((req, res) => res.end("Create new post"));

// Mount router
server.use("/posts", postsRouter);

// GET /posts   -> Get all posts
// POST /posts  -> Create new post
```

#### 5.3 Nested Routers

```ts
const adminRouter = new PipeRouter();
const statsRouter = new PipeRouter();

statsRouter.get("/", (req, res) => res.end("Admin stats"));

adminRouter.use("/stats", statsRouter);
adminRouter.get("/", (req, res) => res.end("Admin dashboard"));

server.use("/admin", adminRouter);

// GET /admin       -> Admin dashboard
// GET /admin/stats -> Admin stats
```

---

### 6. Key Principles

1. **Separation of concerns**: routers define routes, server executes them.
2. **Lazy registration**: routes are only added to the trie after mounting.
3. **Prefixing**: routers can be mounted anywhere without rewriting paths.
4. **Scoped middlewares**: apply globally or per router.
5. **Trie-based matching**: ensures high-performance routing even with modular routers.
6. **Express middleware compatibility**: allows third-party packages to work without modification.
