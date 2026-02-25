import { ServerResponse } from "node:http";

export interface Response extends ServerResponse {
  status(code: number): this;

  json(data: Record<string, any>): this;

  send(...args: any[]): void;

  sendStatus(...args: any[]): void;

  set(field: string, value: string): this;
  set(headers: Record<string, string>): this;

  get(field: string): string | number | string[] | undefined;

  type(value: string): this;

  location(location: string): this;

  links(links: Record<string, string>): void;

  vary(header: string): this;

  append(field: string, value: any): this;

  cookie(...args: any[]): this;

  clearCookie(...args: any[]): this;

  redirect(...args: any[]): this;

  format(fileName: string): this; // 1

  attachment(...args: any[]): void; // 2

  download(...args: any[]): void; // 3

  charset(...args: any[]): void; // 4
}
