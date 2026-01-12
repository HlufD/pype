import { PipeRouter } from "./core/router";
import { PipeServer } from "./core/server";
import { Request } from "./types/request";
import { Response } from "./types/response";

const router = new PipeRouter()
const server = new PipeServer(router);

router.get("/", (req: Request, res: Response) => {
    res.raw.end("This is the home route!!\n")
})


router.post("/", (req: Request, res: Response) => {
    res.raw.end("This is from post route!!\n")
})

server.listen(3000, () => {
    console.log("Server is running on port: 3000")
})

console.log(router)