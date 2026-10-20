import { IncomingHttpHeaders, request as httpRequest, Server } from "http";
import { AddressInfo } from "net";
import { Pype } from "../../src/core/server";

/** A buffered HTTP response. */
export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

/** Options for {@link TestServer.send}. */
export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Abort the request after this many response bytes. */
  abortAfter?: number;
}

/** A running app with a client bound to it. */
export interface TestServer {
  port: number;
  server: Server;
  /** Sends a raw request, the path is not normalized by the client. */
  send(path: string, options?: SendOptions): Promise<Reply>;
  /** Sends a request and parses the JSON response body. */
  json(path: string, options?: SendOptions): Promise<any>;
  close(): Promise<void>;
}

/**
 * Starts `app` on a free port.
 *
 * @example
 * const api = await start(app);
 * const reply = await api.send("/users/1");
 * await api.close();
 */
export async function start(app: Pype): Promise<TestServer> {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  const send = (path: string, options: SendOptions = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          headers: options.headers,
          // A fresh connection per request, so a socket a test made the
          // server destroy is never reused by the next request.
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;

          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            if (options.abortAfter !== undefined && received >= options.abortAfter) {
              req.destroy();
              const body = Buffer.concat(chunks);
              resolve({ status: res.statusCode!, headers: res.headers, body, text: body.toString() });
            }
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({ status: res.statusCode!, headers: res.headers, body, text: body.toString() });
          });
        },
      );
      req.on("error", (error) => {
        if (options.abortAfter === undefined) reject(error);
      });
      req.end(options.body);
    });

  return {
    port,
    server,
    send,
    json: async (path, options) => JSON.parse((await send(path, options)).text),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
