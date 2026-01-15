import { PipeRouter } from "./core/router";
import { PipeServer } from "./core/server";
import { Request } from "./types/request";
import { Response } from "./types/response";

const router = new PipeRouter()
const server = new PipeServer(router);

router.get("/", (req: Request, res: Response) => {
    res.end("hello world")
})

server.listen(3000, () => {
    console.log("Server is running on port: 3000")
})

