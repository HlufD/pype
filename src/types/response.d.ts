import { ServerResponse } from "node:http";

class Response {
  constructor(private response: ServerResponse) {
    this.response = response;
  }
}
