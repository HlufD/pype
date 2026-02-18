import { PypeRouter } from "./core/router";
import { Pype } from "./core/server";
import { NextFunction } from "./types/next-function";
import { Request } from "./types/request";
import { Response } from "./types/response";

const port = 3000;

export { Pype } from "./core/server";

const userRouter = new PypeRouter();
const someRouter = new PypeRouter();

const app = new Pype();

userRouter.get("/users", (eq: Request, res: Response) => {
  // res.json({ users: [{ name: "John" }] });
  res.redirect("/some/route");
});

userRouter.get("/users/:id", (req: Request, res: Response) => {
  return res.json({ userId: req.params.id });
});

someRouter.get("/some/route", (req: Request, res: Response) => {
  return res.json({ message: "This is from the /some route" });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log("this is from the middleware.");
  next();
});

app.use("/api", userRouter);
app.use("/", someRouter);

app.use("/some", (req: Request, res: Response, next: NextFunction) => {
  console.log("This is from middleware 2");
  next();
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});
