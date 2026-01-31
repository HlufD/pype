// import { PipeRouter } from "./core/router";

import { PipeRouter } from "./core/router";

const router = new PipeRouter();

router.get("/users", () => {
  console.log("/users");
});

router.get("/users/:id", () => {
  console.log("/users/:id");
});

router.use("/api/v1", router);

router
  .route("/some/:id")
  .get(() => {})
  .delete(() => {})
  .patch(() => {});

console.log(router);
