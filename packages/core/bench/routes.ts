/** Resources that each get list, create, show and history routes. */
const resources = [
  "users", "posts", "comments", "orders", "products", "invoices",
  "teams", "projects", "issues", "releases", "tags", "webhooks",
];

/** A realistic REST API surface (~60 routes), shared by the benchmarks. */
export const routes: Array<[method: "get" | "post", path: string]> = [
  ["get", "/"],
  ["get", "/health"],
  ...resources.flatMap((r): Array<["get" | "post", string]> => [
    ["get", `/api/${r}`],
    ["post", `/api/${r}`],
    ["get", `/api/${r}/:id`],
    ["get", `/api/${r}/:id/history`],
  ]),
  ["get", "/api/users/:id/posts/:postId/comments/:commentId"],
  ["get", "/static/*"],
];

/** Paths each benchmark requests, keyed by a description. */
export const lookups = {
  "static (/health)": "/health",
  "static, last registered (/api/webhooks)": "/api/webhooks",
  "1 param (/api/users/42)": "/api/users/42",
  "3 params (/api/users/1/posts/2/comments/3)": "/api/users/1/posts/2/comments/3",
  "wildcard (/static/css/app.css)": "/static/css/app.css",
  "not found (/api/nope/1/2)": "/api/nope/1/2",
};
