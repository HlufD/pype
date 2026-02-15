import { IncomingMessage } from "node:http";

export interface Request extends IncomingMessage {
  params: Record<string, string>;

  query?: Record<string, string | string[]>;

  body?: Record<string, any>;

  path?: string;

  hostname?: string;

  protocol?: string;

  secure?: boolean;

  ip?: string;

  ips?: string[];

  cookies?: Record<string, string>;

  signedCookies?: Record<string, string>;

  originalUrl?: string;

  baseUrl?: string;

  fresh?: boolean;

  stale?: boolean;

  xhr?: boolean;

  route?: any;

  get(header: string): string | string[] | undefined;

  header(header: string): string | string[] | undefined;

  accepts(...types: string[]): string | false;

  acceptsCharsets(...charsets: string[]): string | false;

  acceptsEncodings(...encodings: string[]): string | false;

  acceptsLanguages(...langs: string[]): string | false;

  is(type: string): boolean;

  param(name: string, defaultValue?: string): string | undefined;
}
