# Changelog

## 0.1.0 (2026-10-13)

First release.

- Radix tree router with static, `:param`, optional `:param?` and `*`
  segments, URL-decoded params and backtracking.
- Express 5 request and response API, body parsers, `trust proxy` and
  settings.
- Express-compatible pipeline: registration order, error middleware,
  `next("route")`, `next("router")`, routers, `app.route()`.
- Works with Express middleware from npm.

### Security

- Duplicate slashes are collapsed before path-scoped middleware runs, so
  `//admin/secret` can't skip middleware mounted on `/admin`.
- `req.query` and `urlencoded()` bodies have no prototype, so keys like
  `__proto__` can't change them.
- `res.cookie()` rejects names, values, domains and paths that would inject
  into the `Set-Cookie` header.
- `res.sendFile()` closes the file when the client disconnects.
