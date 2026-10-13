import { IncomingMessage } from "http";
import type { Response } from "./response";
import { matchTypes, parseAcceptHeader } from "../utils/helpers";

export class Request extends IncomingMessage {
  res!: Response;
  path = "/";
  params: Record<string, string> = {};
  query: Record<string, string | string[]> = {};
  body?: Record<string, any>;

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()];
  }

  accepts(...serverSupportedTypes: string[]): string | false {
    const acceptHeader = (this.get("Accept") as string) || "*/*";
    const parsedTypes = parseAcceptHeader(acceptHeader);

    for (const { mime } of parsedTypes) {
      for (const supportedType of serverSupportedTypes) {
        if (matchTypes(mime, supportedType)) return supportedType;
      }
    }
    return false;
  }
}
