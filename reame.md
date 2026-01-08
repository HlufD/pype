# Mini Node Middleware Framework (Design & Plan)

A **learning-first backend framework project** built with **pure Node.js + TypeScript**.

🚧 **Current Status**: *Design phase only*. No framework code has been implemented yet.

This repository intentionally starts with **planning, architecture, and design decisions** before any implementation.

The goal is to build a **fully-fledged router** and framework with features approaching production-ready standards by the end of January.

---

## 🎯 Vision

The goal of this project is to deeply understand **how web frameworks work internally**, by designing and building one from scratch.

Specifically, this project aims to:

* Demystify middleware execution
* Build a fully-featured router with advanced matching
* Understand request/response lifecycles
* Learn how frameworks structure their internal layers
* Practice clean API and type design in TypeScript

This is a **learning project**, not meant to replace existing frameworks immediately.

---

## ❓ Why Build This?

Most developers *use* frameworks but rarely see:

* How `next()` actually works
* How routes are matched internally, including parameters and wildcards
* How middleware and interceptors are chained safely
* How abstractions are layered and extensible

By building a framework manually, these details become visible and understandable.

---

## 🧠 Key Design Principles

### 1. Explicit Over Magic

* Every step should be visible
* No hidden side effects
* Simple, readable logic

### 2. Small, Composable Pieces

* Middleware should do one thing
* Router should handle path/method matching
* Interceptors should allow pre/post request hooks
* App should orchestrate server, router, and middleware

### 3. Learning > Performance

* Code clarity is prioritized over speed
* Optimizations can be added later

### 4. Type Safety as Documentation

* Types explain intent
* Minimal use of `any`

---

## 🧩 Core Concepts (Planned)

### Middleware

Middleware will be the **central abstraction**.

* Function signature: `(req, res, next)`
* Runs sequentially in order of registration
* Can:

  * Modify request or response
  * End the request early
  * Pass control using `next()`

### Interceptors

Interceptors extend middleware to **pre- and post-process requests and responses**.

* Function signature: `async (req, res, next) => void`
* Can run **before** route handler
* Can run **after** route handler (by awaiting `next()`)
* Useful for logging, caching, authentication, etc.

### Router (Fully-Fledged)

The router will include:

* Method-based routing (`GET`, `POST`, `PUT`, `DELETE`, etc.)
* Exact and parameterized path matching (`/users/:id`)
* Wildcard support (`/files/*`)
* Optional query parsing
* Route-level middleware and interceptors
* Nested routers for modular design

Execution flow:

```
Incoming Request
  ↓
Global Middleware
  ↓
Global Interceptors (pre)
  ↓
Route Middleware
  ↓
Route Interceptors (pre)
  ↓
Route Handler
  ↓
Route Interceptors (post)
  ↓
Global Interceptors (post)
  ↓
Response Sent
```

### Application Layer

The `App` abstraction will:

* Own the HTTP server
* Manage global middleware and interceptors
* Register routes and nested routers
* Orchestrate middleware and interceptor pipelines

Express-like API example:

```ts
app.use(globalMiddleware)
app.useInterceptor(globalInterceptor)
app.get('/users/:id', routeMiddleware, routeHandler)
app.listen(3000)
```

---

## 🗂 Planned Project Structure

```
mini-node-framework/
├── src/
│   ├── core/
│   │   ├── app.ts          # Application orchestration & server lifecycle
│   │   ├── router.ts       # Full-featured router logic
│   │   ├── middleware.ts   # Middleware pipeline executor
│   │   ├── interceptor.ts  # Interceptor execution engine
│   │   └── types.ts        # Core TypeScript types
│   └── index.ts            # User-facing entry point
├── dist/                   # Compiled JavaScript
├── tsconfig.json
└── package.json
```

---

## 🛣 Detailed Development Plan (Till End of January)

### Phase 0 – Foundation & Design

* Initialize project & TypeScript
* Define folder structure
* Define core types (`Request`, `Response`, `Middleware`, `Interceptor`, `NextFunction`)

### Phase 1 – Raw HTTP Server

* Create `http.createServer`
* Inspect `IncomingMessage` & `ServerResponse`
* Send basic responses

### Phase 2 – Middleware Engine

* Implement middleware pipeline
* Support `next()` chaining
* Early response termination
* Global & route-level middleware

### Phase 3 – Interceptors

* Implement interceptor pipeline
* Support pre/post hooks
* Global & route-level interceptors

### Phase 4 – Fully-Fledged Router

* Exact & parameterized route matching
* Wildcard paths
* Nested routers
* Route-specific middleware and interceptors
* Optional query parsing

### Phase 5 – Application Abstraction

* Orchestrate server, router, middleware, interceptors
* Expose clean API (`use`, `useInterceptor`, `get`, `post`, etc.)

### Phase 6 – Optional Enhancements

* Async middleware & interceptors
* Error-handling middleware
* JSON body parsing
* Logging utilities
* Configurable router options (case sensitivity, strict matching)

---

## 🚫 Non-Goals

* Be production-ready out-of-the-box
* Replace Express or Fastify
* Optimize for speed initially
* Hide framework internals

---

## 📚 Expected Learning Outcomes

* Deep understanding of middleware and interceptor pipelines
* Experience building a router with parameterized paths and wildcards
* Ability to design a framework API from scratch
* Strong TypeScript design experience

---

## 🧩 Philosophy

> "Frameworks are just patterns, written down in code."

This README is a **living design document** and should evolve as the framework develops. Each implementation step should update it, explaining both *how* and *why* decisions are made.
