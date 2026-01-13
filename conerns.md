# Route Registration Code Review

## Overview
This document reviews the current Trie-based **static route registration** implementation.  
It highlights **five critical concerns**, explains their risks and impacts, and provides clear guidance on what needs improvement.

---

## 🚨 Critical Concerns

### 1. Silent Route Overwrites (No Warnings)

**Current Behavior**
```ts
trie.insert("/users", GET, handler1);
trie.insert("/users", GET, handler2); // handler1 is silently overwritten
```

**Problem**
- Existing handlers are replaced without any warning or error.
- Developers may unintentionally redefine routes.

**Risk**
- Debugging becomes difficult.
- Expected handlers may never execute.

**Impact**
- **Medium** — leads to subtle runtime bugs.

**Recommendation**
- Detect duplicates and:
  - throw an error, or
  - log a warning, or
  - explicitly support handler stacking.

---

### 2. Missing Runtime Input Validation

**Current Issues**
```ts
trie.insert("/users", "INVALID_METHOD" as any, handler);
trie.insert("/users", GET, null as any);
trie.insert("/users", GET, []);
```

**Problem**
- TypeScript safety is bypassed at runtime.
- Invalid inputs are accepted without checks.

**Risk**
- Runtime crashes.
- Undefined behavior during request handling.

**Impact**
- **High** — may crash the application.

**Recommendation**
- Validate:
  - HTTP method correctness
  - handler type (must be function or non-empty array)
  - reject invalid values early

---

### 3. Inefficient Memory Usage Pattern

**Current Pattern**
```ts
for (const segment of segments) {
    if (!currNode.children) {
        currNode.children = new Map();
    }
}
```

**Problem**
- Repeated null checks inside loops.
- Slightly inefficient for large route trees.

**Risk**
- Increased memory churn.
- Minor performance degradation.

**Impact**
- **Low–Medium** — noticeable at scale.

**Recommendation**
- Initialize node state eagerly or ensure one-time allocation.

---

### 4. No Error Boundaries During Registration

**Current State**
- Route insertion assumes everything is valid.
- No protection against unexpected runtime errors.

**Risk**
- One malformed route can crash startup.
- Hard failure during application boot.

**Impact**
- **Medium** — reduces application resilience.

**Recommendation**
- Wrap registration logic in controlled error handling.
- Fail fast with meaningful error messages.

---

### 5. No Route Sanitization

**Current Behavior**
```ts
trie.insert("", GET, handler);                 // Empty path → root
trie.insert("/users//profile//", GET, handler); // Multiple slashes
trie.insert("users/profile", GET, handler);     // Missing leading slash
```

**Problem**
- Multiple representations of the same route.
- Inconsistent matching behavior.

**Risk**
- Routes appear registered but never match.
- Hard-to-debug "route not found" errors.

**Impact**
- **Medium** — correctness and developer experience issues.

**Recommendation**
- Normalize routes:
  - enforce leading slash
  - collapse duplicate slashes
  - reject empty or malformed paths

---

## ✅ Summary

The current Trie-based router is structurally solid, but **production readiness requires**:

- Runtime validation
- Duplicate route protection
- Path normalization
- Defensive error handling

Addressing these will significantly improve **correctness, debuggability, and robustness**.



-----------------------------------------------------------------------------------------------

# Express Routing Rules Cheat Sheet

This cheat sheet summarizes **how Express handles static routes, dynamic params, optional params, and wildcards**.

---

## 1️⃣ Static Routes

* Exact string match.
* Examples:

```js
app.get('/home', handler);
app.post('/user/login', handler);
```

---

## 2️⃣ Dynamic Parameters (`:param`)

* Matches **exactly one segment**.
* Captured in `req.params`.
* Examples:

```js
app.get('/user/:id', (req, res) => {
  console.log(req.params.id);
});
```

* `/user/123` → `req.params.id = '123'`
* `/user/` → does **not match**

---

## 3️⃣ Optional Dynamic Parameters (`:param?`)

* Matches **0 or 1 segment**.
* Must be **at the end of the route** for predictable behavior.
* Examples:

```js
app.get('/user/:id?', (req, res) => {
  console.log(req.params.id);
});
```

* `/user/123` → `req.params.id = '123'`
* `/user` → `req.params.id = undefined`

### Multiple Optional Params (at end)

```js
app.get('/post/:category?/:postId?', (req, res) => {
  console.log(req.params);
});
```

* `/post/tech/123` → `{ category: 'tech', postId: '123' }`
* `/post/tech` → `{ category: 'tech' }`
* `/post` → `{}`

**Note:** Optional params in the middle are not recommended — may cause ambiguous routing.

---

## 4️⃣ Wildcards

### a) Single-segment wildcard (`*`)

* Matches **exactly one segment**.
* Can appear anywhere.
* Example:

```js
app.get('/files/*/download', handler);
```

* `/files/image/download` → matches
* `/files/image/2026/download` → does **not match**

### b) Multi-segment wildcard (`**`) / catch-all

* Matches **0 or more segments**, including nested paths.
* Should **always be at the end** of the route.
* Example:

```js
app.get('/files/**', handler);
```

* `/files/a` → matches
* `/files/a/b` → matches
* `/files/` → matches

**Warning:** Multi-segment wildcards in the middle require backtracking — slow and unpredictable.

---

## 5️⃣ Priority Rules

1. **Static > Dynamic > Wildcard**
2. Dynamic params match exactly **one segment**
3. Optional params match **0 or 1 segment**, ideally at the end
4. `*` matches **1 segment**, anywhere
5. `**` matches **multiple segments**, at the end only
6. Avoid mixing optional params and multi-segment wildcards in the middle

---

**Tip:** For designing a Trie-based router, keep these rules in mind when implementing insert/find logic to mimic Express behavior.
