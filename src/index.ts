import { PipeServer } from "./core/server";
import { NextFunction } from "./types/middleware";
import { Request } from "./types/request";
import { Response } from "./types/response";

const app = new PipeServer();

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log("This runs first");
  next();
});

app.get("/", async (req: Request, res: Response) => {
  console.log("this runs second");
  res.end("hello world");
});

app
  .route("/someone")
  .get((req: Request, res: Response) => {
    console.log("This is from /someone GET");
    res.end("Hello ");
  })
  .post((req: Request, res: Response) => {
    console.log("This is from /someone POST");
    res.end("Hello ");
  });

app.listen(3000, () => {
  console.log("Server is running on port: 3000");
});
