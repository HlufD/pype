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

  type(value: string): this;

  location(location: string): this;

  links(links: Record<string, string>): void;

  vary(...args: any[]): void;

  append(field: string, value: any): this;

  cookie(...args: any[]): this;

  clearCookie(...args: any[]): this;

  redirect(...args: any[]): this;

  format(...args: any[]): void;

  attachment(...args: any[]): void;

  download(...args: any[]): void;

  charset(...args: any[]): void;
}
