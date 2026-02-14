import { IncomingMessage } from "node:http";

export interface Request extends IncomingMessage {
  params: Record<string, string>;

  query?: Record<string, string | string[]>;

  body: Record<string, any>;

  get(header: string): string | string[] | undefined;
}
