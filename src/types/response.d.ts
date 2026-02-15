import { ServerResponse } from "node:http";

export interface Response extends ServerResponse {
  status(code: number): this;

  json(data: Record<string, any>): this;

  send(...args: any[]): void;

  jsonp(...args: any[]): void;

  sendStatus(...args: any[]): void;

  set(field: string, value: string): this;
  set(headers: Record<string, string>): this;

  get(field: string): string | number | string[] | undefined;

  type(...args: any[]): void;

  location(...args: any[]): void;

  links(...args: any[]): void;

  vary(...args: any[]): void;

  append(...args: any[]): void;

  cookie(...args: any[]): void;

  clearCookie(...args: any[]): void;

  redirect(...args: any[]): void;

  format(...args: any[]): void;

  attachment(...args: any[]): void;

  download(...args: any[]): void;

  charset(...args: any[]): void;
}
