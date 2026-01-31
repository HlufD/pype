import { IncomingMessage } from "node:http";

class Request {
  constructor(private request: IncomingMessage) {
    this.request = request;
  }
}
