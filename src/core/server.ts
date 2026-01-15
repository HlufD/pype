import { createServer, IncomingMessage, Server, ServerResponse } from "node:http"
import { Response } from "../types/response";
import { PipeRouter } from "./router";
import { HTTP_METHODS } from "../enums/methods.enum";
export class PipeServer {

    private router: PipeRouter;

    constructor(router: PipeRouter) {
        this.router = router;
    }

    public listen(port: number, callback?: () => void) {
        const server = createServer(this.handleRequest.bind(this))
        server.listen(port, callback)
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse) {
        const method = req.method;
        const path = req.url!;
        const matchedRoute = this.router.match(method?.toLocaleLowerCase() as HTTP_METHODS, path);
        if (matchedRoute) {
            matchedRoute.handlers.forEach((handler) => {
                handler(req, res)
            })
        } else {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain");
            res.end("Not Found");
        }
    }
}
