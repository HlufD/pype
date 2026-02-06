import { ServerResponse } from "node:http";

class Response {
  constructor(response: ServerResponse) {
    this.response = response;
  }
}
