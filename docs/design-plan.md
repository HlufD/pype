# Mini Node Middleware Framework (Design & Plan)

A **learning-first backend framework project** built with **pure Node.js + TypeScript**.

🚧 **Current Status**: *Design phase only*. No framework code has been implemented yet.

This repository intentionally starts with **planning, architecture, and design decisions** before any implementation.

The goal is to build a **fully-fledged router and middleware framework** with features approaching production-ready standards by the end of January.

---

## 🎯 Vision

The goal of this project is to deeply understand **how web frameworks work internally**, by designing and building one from scratch.

This project aims to:

* Demystify middleware execution and control flow
* Build a fully-featured router with advanced path matching
* Understand request/response lifecycles in Node.js
* Learn how frameworks layer abstractions internally
* Practice clean API and strong type design in TypeScript

This is a **learning project**, not intended to replace existing frameworks.

---

## ❓ Why Build This?

Most developers *use* frameworks but rarely see:

* How `next()` actually advances execution
* How middleware chains are implemented safely
* How route matching works internally (params, wildcards)
* How pre/post request hooks are structured
* How frameworks balance flexibility with simplicity

Building a framework manually makes these mechanisms **explicit and understandable**.

---

## 🧠 Core Design Principles

---

## ✅ Explicit Feature List

This section lists **concrete, testable features** the framework is expected to support. Each item represents a capability that must be deliberately designed and implemented.

### Core Server Features

* HTTP server built on Node.js `http` module
* Single entry request handler
* Graceful server start and shutdown
* Per-request lifecycle isolation

---

### Request Features

* Normalized HTTP method
* Parsed pathname (`req.path`)
* Optional query string parsing
* Route parameter extraction
* Header normalization
* Per-request mutable context store
* Body parsing via middleware (JSON, text – optional)

---

### Response Features

* Status code control
* Header management
* Plain text responses
* JSON responses
* Single-send guarantee
* Automatic pipeline termination after response

---

### Middleware Features

* Global middleware registration
* Router-level middleware
* Route-level middleware
* Sequential execution order
* `next()`-based flow control
* Sync & async middleware support
* Early response termination
* Guard against multiple `next()` calls

---

### Interceptor Features

* Global interceptors
* Route-level interceptors
* Pre-handler execution
* Post-handler execution
* Reverse-order post execution
* Async-only enforcement
* Around-style control flow

---

### Router Features

* Method-based routing (`GET`, `POST`, etc.)
* Exact path matching
* Parameterized paths (`:id`)
* Single-segment wildcards (`*`)
* Multi-segment wildcards (`**`)
* Route precedence rules
* Configurable case sensitivity
* Optional strict trailing slash handling

---

### Nested Router Features

* Mount routers at base paths
* Middleware inheritance
* Interceptor inheritance
* Isolated route tables
* Modular routing design

---

### Error Handling Features (Planned)

* Centralized error propagation
* Error-handling middleware signature
* Async error capture
* Default error responses

---

### Extensibility Features

* Pluggable middleware
* Pluggable interceptors
* Configurable router behavior
* Future support for plugins

---

### Developer Experience Features

* Strong TypeScript typings
* Clear execution order guarantees
* Predictable behavior
* Minimal magic
* Readable internal APIs

---

## 🧠 Core Design P

### 1. Explicit Over Magic

* Every execution step is visible
* No hidden side effects
* Simple, readable logic over clever abstractions

### 2. Small, Composable Pieces

* Middleware does one thing
* Router handles matching and dispatching
* Interceptors handle lifecycle concerns
* App orchestrates everything

### 3. Learning > Performance

* Readability first
* No premature optimization
* Performance improvements come later

### 4. Type Safety as Documentation

* Types express intent
* Minimal `any`
* Strong contracts between layers

---

## 🧱 Core Abstractions

### Request Abstraction

Wraps Node’s `IncomingMessage` into a framework-level request object.

**Planned Properties:**

* `req.raw` – original `IncomingMessage`
* `req.method` – HTTP method (normalized)
* `req.url` – raw request URL
* `req.path` – pathname without query
* `req.query` – parsed query parameters (optional)
* `req.params` – route parameters
* `req.headers` – normalized headers
* `req.body` – populated by body parsers
* `req.context` – per-request shared state

**Design Rules:**

* Core fields are immutable
* Extension points are explicit (`context`, `params`)
* No automatic parsing without middleware

---

### Response Abstraction

Wraps Node’s `ServerResponse`.

**Planned API:**

* `res.raw`
* `res.status(code)`
* `res.setHeader(name, value)`
* `res.send(body)`
* `res.json(data)`
* `res.end()`
* `res.headersSent`

**Rules:**

* Response can only be sent once
* Pipeline stops after response ends
* Explicit send methods only

---

## 🔁 Middleware System

### Middleware Definition

```
(req, res, next) => void | Promise<void>
```

### Middleware Capabilities

Middleware may:

* Modify request or response
* Attach data to `req.context`
* End the request early
* Call `next()` to continue

Middleware must not:

* Call `next()` after response ends
* Call `next()` multiple times

Framework will guard against misuse.

---

### Middleware Execution Rules

* Executed in registration order
* Supports sync and async functions
* `next()` advances execution index
* If `next()` is not called → execution stops
* If response ends → execution stops automatically

---

### Middleware Scopes

* **Global middleware** – runs for every request
* **Router middleware** – runs for all routes in a router
* **Route middleware** – runs only for a specific route

**Execution Order:**

```
Global Middleware
→ Router Middleware
→ Route Middleware
→ Route Handler
```

---

## 🪝 Interceptors

Interceptors are middleware with **lifecycle awareness**.

### Interceptor Definition

```
async (req, res, next) => void
```

### Key Characteristics

* Always async
* Can execute logic:

  * Before `await next()`
  * After `await next()`
* Enable around-style execution

---

### Interceptor Use Cases

* Request/response logging
* Execution timing & metrics
* Authentication & authorization
* Caching layers
* Response transformation
* Transaction boundaries

---

### Interceptor Execution Flow

```
Global Interceptors (pre)
→ Route Interceptors (pre)
→ Route Handler
→ Route Interceptors (post)
→ Global Interceptors (post)
```

Rules:

* Post phase runs in reverse order
* Early response may skip post phase (configurable)

---

## 🧭 Router Design

### Route Definition

Each route consists of:

* HTTP method
* Path pattern
* Optional middleware
* Optional interceptors
* Single handler

---

### Path Matching Features

#### Exact Paths

```
/users
/users/profile
```

#### Parameterized Paths

```
/users/:id
/orders/:orderId/items/:itemId
```

* Extracted into `req.params`
* Supports multiple parameters

---

#### Wildcards

```
/files/*
/assets/**
```

* `*` → single segment
* `**` → greedy multi-segment
* Captured explicitly

---

### Route Matching Rules

* Method must match
* Path tokens matched sequentially
* First matching route wins (configurable later)
* Case sensitivity configurable

---

### Nested Routers

* Routers can be mounted at a base path
* Nested routers inherit middleware & interceptors
* Enables modular architecture

---

## 🧩 Application Layer

The `App` abstraction is responsible for:

* Owning the HTTP server
* Managing global middleware and interceptors
* Registering routers and routes
* Orchestrating the execution pipeline

---

### Public API (Planned)

```
app.use(middleware)
app.useInterceptor(interceptor)

app.get(path, ...handlers)
app.post(path, ...handlers)

app.mount('/api', router)

app.listen(port)
```

---

## 🗂 Planned Project Structure

```
mini-node-framework/
├── src/
│   ├── core/
│   │   ├── app.ts
│   │   ├── router.ts
│   │   ├── middleware.ts
│   │   ├── interceptor.ts
│   │   └── types.ts
│   └── index.ts
├── dist/
├── tsconfig.json
└── package.json
```

---

## 🛣 Development Roadmap

### Phase 0 – Design & Types

* Project setup
* Core type definitions
* README as living design doc

### Phase 1 – Raw HTTP Server

* Create server
* Inspect Node request/response

### Phase 2 – Middleware Engine

* Pipeline execution
* `next()` control flow

### Phase 3 – Interceptors

* Pre/post execution
* Async control

### Phase 4 – Router

* Path matching
* Params & wildcards
* Nested routers

### Phase 5 – Application Layer

* Orchestration
* Public API

### Phase 6 – Enhancements (Optional)

* Error-handling middleware
* Body parsers
* Logging utilities
* Configurable options

---

## 🚫 Non-Goals

* Production readiness
* Replacing Express/Fastify
* High-performance focus initially
* Hiding internals

---

## 📚 Expected Learning Outcomes

* Deep understanding of middleware pipelines
* Router internals & path matching
* Lifecycle-based execution
* Framework-level API design
* Strong TypeScript modeling skills

---

## 🧩 Philosophy

> "Frameworks are just patterns, written down in code."

This README is a **living design document** and should evolve alongside implementation, documenting both **how** and **why** decisions are made.
