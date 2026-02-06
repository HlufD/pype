import { IncomingMessage } from "node:http";

class Request {
  constructor(request: IncomingMessage) {
    this.request = request;
  }
  params: Record<string, any> = {};
}
