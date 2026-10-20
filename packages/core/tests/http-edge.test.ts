import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, Socket } from "net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import { Pype } from "../src/core/server";
import { json } from "../src/middlewares/body-parser";
import { start, TestServer } from "./support/http";

/**
 * HTTP edge cases checked on the raw socket, where a normal client would
 * hide the bytes, against both Express and Pype.
 */

type Kind = "express" | "pype";

/** Body parser errors seen by each app's error middleware. */
const errors: Record<Kind, string[]> = { express: [], pype: [] };

/** The same routes on both frameworks. */
function define(app: any, kind: Kind) {
  const parser = kind === "express" ? express.json : json;
  app.get("/text", (_req: any, res: any) => res.send("hello"));
  app.get("/a", (_req: any, res: any) => res.send("a"));
  app.get("/b", (_req: any, res: any) => res.send("b"));
  app.get("/no-content", (_req: any, res: any) => res.status(204).send("dropped"));
  app.post("/json", parser(), (req: any, res: any) => res.json(req.body));
  app.get("/big-file", (_req: any, res: any) => res.sendFile(join(fileRoot, "big.bin")));
  app.use((err: any, _req: any, res: any, _next: any) => {
    errors[kind].push(err.type ?? err.message);
    if (!res.headersSent) res.status(err.status ?? 500).json({ type: err.type });
  });
}

const servers = {} as Record<Kind, TestServer>;
const fileRoot = mkdtempSync(join(tmpdir(), "pype-edge-"));

beforeAll(async () => {
  writeFileSync(join(fileRoot, "big.bin"), Buffer.alloc(8 * 1024 * 1024, 1));
  const e = express();
  define(e, "express");
  const p = new Pype({ env: "test" });
  define(p, "pype");
  servers.express = await start(e as any);
  servers.pype = await start(p);
});

afterAll(async () => {
  await Promise.all([servers.express.close(), servers.pype.close()]);
  rmSync(fileRoot, { recursive: true, force: true });
});

/** Opens a raw connection to one of the servers. */
function open(kind: Kind): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(servers[kind].port, "127.0.0.1", () => resolve(socket));
    socket.on("error", reject);
  });
}

/**
 * Writes `data` and collects what comes back until the server closes the
 * connection or nothing arrives for `idle` ms.
 */
async function exchange(kind: Kind, data: string | Buffer, options: { idle?: number; end?: boolean } = {}) {
  const socket = await open(kind);
  return new Promise<string>((resolve) => {
    let received = "";
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(received);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, options.idle ?? 150);
    };
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      arm();
    });
    socket.on("close", finish);
    socket.on("error", finish);
    socket.write(data);
    if (options.end) socket.end();
    arm();
  });
}

/** One parsed response from a raw stream: status line, headers and the exact body bytes. */
interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Splits raw bytes into responses, using `Content-Length` to find each
 * body, so pipelined responses and extra body bytes show up.
 */
function parseResponses(raw: string, bodiless = false): RawResponse[] {
  const responses: RawResponse[] = [];
  let rest = raw;

  while (rest.startsWith("HTTP/1.1 ")) {
    const end = rest.indexOf("\r\n\r\n");
    if (end === -1) break;
    const [statusLine, ...lines] = rest.slice(0, end).split("\r\n");
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    rest = rest.slice(end + 4);
    const status = Number(statusLine.split(" ")[1]);
    const length = bodiless || status === 100 ? 0 : Number(headers["content-length"] ?? rest.length);
    responses.push({ status, headers, body: rest.slice(0, length) });
    rest = rest.slice(length);
  }

  if (rest.length > 0) responses.push({ status: -1, headers: {}, body: rest });
  return responses;
}

const KINDS: Kind[] = ["express", "pype"];

describe.each(KINDS)("%s on the raw socket", (kind) => {
  it("HEAD sends the GET headers and not a single body byte", async () => {
    const [get] = parseResponses(await exchange(kind, "GET /text HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    const raw = await exchange(kind, "HEAD /text HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    const responses = parseResponses(raw, true);

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(200);
    expect(responses[0].headers["content-length"]).toBe(get.headers["content-length"]);
    expect(raw.endsWith("\r\n\r\n")).toBe(true);
  });

  it("204 and 304 responses have no body bytes and no Content-Length", async () => {
    const raw204 = await exchange(kind, "GET /no-content HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(raw204.endsWith("\r\n\r\n")).toBe(true);
    expect(parseResponses(raw204, true)[0].headers["content-length"]).toBeUndefined();

    const [first] = parseResponses(await exchange(kind, "GET /text HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    const raw304 = await exchange(
      kind,
      `GET /text HTTP/1.1\r\nHost: x\r\nIf-None-Match: ${first.headers.etag}\r\nConnection: close\r\n\r\n`,
    );
    const [notModified] = parseResponses(raw304, true);
    expect(notModified.status).toBe(304);
    expect(notModified.headers["content-length"]).toBeUndefined();
    expect(raw304.endsWith("\r\n\r\n")).toBe(true);
  });

  it("answers several requests on one keep-alive connection", async () => {
    const socket = await open(kind);
    const read = () => new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(chunk.toString())));

    socket.write("GET /a HTTP/1.1\r\nHost: x\r\n\r\n");
    const first = parseResponses(await read());
    socket.write("GET /b HTTP/1.1\r\nHost: x\r\n\r\n");
    const second = parseResponses(await read());
    socket.destroy();

    expect(first.map((r) => r.body)).toEqual(["a"]);
    expect(second.map((r) => r.body)).toEqual(["b"]);
    expect(first[0].headers.connection).toBe("keep-alive");
  });

  it("answers pipelined requests in order", async () => {
    const raw = await exchange(
      kind,
      "GET /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\nGET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(parseResponses(raw).map((r) => [r.status, r.body])).toEqual([
      [200, "a"],
      [200, "b"],
      [200, "a"],
    ]);
  });

  it("passes a request.aborted error when the client disconnects mid-body, and keeps serving", async () => {
    errors[kind].length = 0;
    const socket = await open(kind);
    socket.write('POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(errors[kind]).toEqual(["request.aborted"]);
    const [next] = parseResponses(await exchange(kind, "GET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    expect(next.body).toBe("a");
  });

  it("parses a body sent after 100 Continue", async () => {
    const socket = await open(kind);
    const chunks: string[] = [];
    socket.on("data", (chunk) => chunks.push(chunk.toString()));

    socket.write('POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 7\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chunks.join("")).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\n$/);

    socket.write('{"a":1}');
    await new Promise((resolve) => socket.once("close", resolve));
    const responses = parseResponses(chunks.join(""));
    expect(responses.map((r) => r.status)).toEqual([100, 200]);
    expect(responses[1].body).toBe('{"a":1}');
  });

  it("ignores a client that disconnects during res.sendFile() and keeps serving", async () => {
    errors[kind].length = 0;
    const socket = await open(kind);
    socket.write("GET /big-file HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise((resolve) => socket.once("data", resolve));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(errors[kind]).toEqual([]);
    const [next] = parseResponses(await exchange(kind, "GET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    expect(next.body).toBe("a");
  });

  it("still answers a half-closed connection", async () => {
    const raw = await exchange(kind, "GET /a HTTP/1.1\r\nHost: x\r\n\r\n", { end: true });
    expect(parseResponses(raw).map((r) => r.body)).toEqual(["a"]);
  });
});

describe("malformed requests are rejected like Express", () => {
  const cases: [string, string][] = [
    ["huge headers", `GET /a HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`],
    ["invalid Content-Length", "POST /json HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n"],
    ["conflicting Content-Length", "POST /json HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello"],
    [
      "Transfer-Encoding with Content-Length",
      "POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
    ],
    ["invalid Transfer-Encoding", "POST /json HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked, identity\r\n\r\n0\r\n\r\n"],
    ["space in the request line", "GET /a b HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["header without a colon", "GET /a HTTP/1.1\r\nHost: x\r\nBroken header\r\n\r\n"],
    ["bare LF line endings", "GET /a HTTP/1.1\nHost: x\n\n"],
    ["missing Host on HTTP/1.1", "GET /a HTTP/1.1\r\n\r\n"],
    ["unsupported HTTP version", "GET /a HTTP/9.9\r\nHost: x\r\n\r\n"],
  ];

  it.each(cases)("%s", async (_name, request) => {
    const [fromExpress, fromPype] = await Promise.all(KINDS.map((kind) => exchange(kind, request)));
    const statusOf = (raw: string) => raw.split("\r\n")[0];
    expect(statusOf(fromExpress)).toMatch(/^HTTP\/1\.1 4\d\d /);
    expect(statusOf(fromPype)).toBe(statusOf(fromExpress));
  });
});
