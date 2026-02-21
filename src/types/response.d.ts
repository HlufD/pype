import { ServerResponse } from "node:http";

export interface Response extends ServerResponse {
  status(code: number): this;

  json(data: Record<string, any>): this;

  send(...args: any[]): void;

  jsonp(...args: any[]): void; // 1

  sendStatus(...args: any[]): void;

  set(field: string, value: string): this;
  set(headers: Record<string, string>): this;

  get(field: string): string | number | string[] | undefined;

  type(value: string): this; // 2

  location(location: string): this;

  links(links: Record<string, string>): void;

  vary(...args: any[]): void; // 3

  append(...args: any[]): void; // 4

  cookie(...args: any[]): this;

  clearCookie(...args: any[]): this;

  redirect(...args: any[]): this;

  format(...args: any[]): void; // 5

  attachment(...args: any[]): void; // 6

  download(...args: any[]): void; // 7

  charset(...args: any[]): void; // 8
}
