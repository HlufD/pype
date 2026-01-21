# Router Matching Rules (Authoritative Specification)

This document defines the **exact matching behavior** of the router.
These rules MUST be true before writing or modifying any implementation code.

There are no implicit behaviors.
There is no ambiguity.
There is no magic.

---

## 1️⃣ Route Precedence (Absolute)

For each path segment, matching is attempted in the following order:

1. **STATIC segment**
2. **PARAMETER segment**
3. **WILDCARD segment**

This order is strict and never changes.

### Example

/users/me > /users/:id > /users/\*

If a higher-priority match exists, lower-priority matches are ignored  
**unless backtracking is required** (see Wildcard Rules).

---

## 2️⃣ Wildcard Rules

### Definition

- Wildcard is represented by `*`
- A wildcard matches **zero or more remaining segments**

### Constraints

1. `*` **MUST be the last segment** in a route
2. Only one wildcard is allowed per route

### Matching Behavior

A wildcard match is considered **only if**:

- No deeper exact match exists, **OR**
- No handler exists at the current node

Because of this, wildcard matching **requires backtracking**.

---

## 3️⃣ Parameter Rules

### Definition

- Parameters are represented as `:name`
- A parameter matches **exactly one segment**

### Constraints

1. Only one parameter is allowed per segment
2. Parameter names must be **consistent per position**

#### Invalid Example

/users/:id
/users/:userId ❌ Conflict (same position, different name)

### Matching Behavior

- Parameter matching is **greedy**
- Parameter matching has **lower priority than static segments**
- Parameter matching has **higher priority than wildcards**

---

## 4️⃣ Optional Parameter Rules

### Definition

- Optional parameters are represented as `:name?`

### Constraints

1. Optional parameters **MUST be placed at the end** of the route
2. Only one optional parameter is allowed per route

### Expansion Behavior

Optional parameters do **NOT** affect matching logic.

They are expanded at **registration time** only.

#### Example

/users/:id? expands into

- /users
- /users/:id

Each expanded route is registered independently.

---

## 5️⃣ Handler Resolution Rules

After path traversal is complete:

1. If a handler exists at the current node → **return it**
2. Else if a wildcard backtrack exists → **use the wildcard handler**
3. Else → **no match**

There is no fallback beyond this.
There is no partial match.
There is no guessing.

---

## 6️⃣ Summary

- Static > Parameter > Wildcard
- Wildcards require backtracking
- Parameters match exactly one segment
- Optional parameters affect registration, not matching
- Handler resolution is deterministic

If behavior is unclear, it is a bug in the implementation — not in these rules.
