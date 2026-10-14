import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import cookieParser from "cookie-parser";
import { Pype } from "../src/core/server";
import { Request } from "../src/core/request";
import { Response } from "../src/core/response";
import { start, TestServer } from "./support/http";

const root = mkdtempSync(join(tmpdir(), "pype-response-"));
const sendFileResults: string[] = [];
let api: TestServer;

beforeAll(async () => {
  mkdirSync(join(root, "dir"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "data.json"), '{"ok":true}');
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
  writeFileSync(join(root, "unknown.zzz"), "?");
  writeFileSync(join(root, ".hidden", "file.txt"), "hidden");

  const app = new Pype({ "json spaces": 2 });
  app.use(cookieParser("secret"));

  app.get("/status/:code", (req: Request, res: Response) => {
    res.status(Number(req.params.code)).send("x");
  });
  app.get("/send/buffer", (_req: Request, res: Response) => {
    res.send(Buffer.from("raw"));
  });
  app.get("/send/typed-array", (_req: Request, res: Response) => {
    res.send(new Uint8Array([104, 105]));
  });
  app.get("/send/null", (_req: Request, res: Response) => {
    res.send(null);
  });
  app.get("/send/undefined", (_req: Request, res: Response) => {
    res.send();
  });
  app.get("/send/205", (_req: Request, res: Response) => {
    res.status(205).send("dropped");
  });
  app.get("/send/twice", (_req: Request, res: Response) => {
    res.send("first");
    res.send("second");
  });
  app.get("/send-status", (_req: Request, res: Response) => {
    res.sendStatus(418);
  });
  app.get("/json-spaces", (_req: Request, res: Response) => {
    res.json({ a: 1 });
  });
  app.get("/json-undefined", (_req: Request, res: Response) => {
    res.json(undefined);
  });
  app.get("/set-content-type-array", (_req: Request, res: Response) => {
    res.set("Content-Type", ["a/b", "c/d"]);
  });
  app.get("/set-missing-value", (_req: Request, res: Response) => {
    res.set("X-A");
  });
  app.get("/type", (_req: Request, res: Response) => {
    res.type("").type(".unknownext").send("x");
  });
  app.get("/redirect/head", (_req: Request, res: Response) => {
    res.redirect(303, "/elsewhere");
  });
  app.get("/redirect/missing", (_req: Request, res: Response) => {
    res.redirect("");
  });
  app.get("/redirect/after-send", (_req: Request, res: Response) => {
    res.send("done");
    res.redirect("/never");
  });
  app.get("/links", (_req: Request, res: Response) => {
    res
      .links({ next: "/p/2", alternate: ["/a", "/b"], bad: 1 as unknown as string })
      .links({ last: "/p/9" })
      .links(null as unknown as Record<string, string>)
      .send("ok");
  });
  app.get("/vary", (_req: Request, res: Response) => {
    res.vary("").vary("Accept, Origin").vary("origin, Cookie").send("ok");
  });
  app.get("/vary-star", (_req: Request, res: Response) => {
    res.vary("Accept").vary("*").vary("Origin").send("ok");
  });
  app.get("/append", (_req: Request, res: Response) => {
    res.append("X-List", "a").append("X-List", ["b", "c"]).append("X-List", "d").send("ok");
  });
  app.get("/cookies/set", (_req: Request, res: Response) => {
    res
      .cookie("prefs", { dark: true }, { httpOnly: true, secure: true, sameSite: "lax", priority: "high", partitioned: true, domain: "example.com", path: "/app", maxAge: 60_000 })
      .cookie("strict", "1", { sameSite: true })
      .clearCookie("old", { maxAge: 5 })
      .send("ok");
  });
  app.get("/cookies/unsigned-secret", (_req: Request, res: Response) => {
    delete (res.req as Request).secret;
    res.cookie("s", "1", { signed: true });
  });
  app.get("/cookies/bad-name", (_req: Request, res: Response) => {
    res.cookie("bad;name", "1");
  });
  app.get("/format", (_req: Request, res: Response) => {
    res.format({
      json: () => res.send({ format: "json" }),
      "text/plain": () => res.send("text"),
      default: () => res.status(299).send("default"),
    });
  });
  app.get("/format/none", (_req: Request, res: Response) => {
    res.format({ json: () => res.send({}) });
  });
  app.get("/attachment", (_req: Request, res: Response) => {
    res.attachment().send("x");
  });

  app.get("/file/:name", (req: Request, res: Response) => {
    res.sendFile(req.params.name, {
      root,
      maxAge: 3_600_000,
      immutable: true,
      headers: { "X-Served": "yes" },
    });
  });
  app.get("/file-plain/*", (req: Request, res: Response) => {
    res.sendFile(req.params["*"], {
      root,
      cacheControl: false,
      lastModified: false,
      etag: false,
      acceptRanges: false,
      dotfiles: (req.query.dotfiles as "allow" | "deny") ?? "ignore",
    });
  });
  app.get("/file-callback/:name", (req: Request, res: Response) => {
    res.sendFile(join(root, req.params.name), (error) => {
      sendFileResults.push(error ? `error:${(error as NodeJS.ErrnoException).code ?? error.message}` : "ok");
      if (error && !res.headersSent) res.status(404).send("custom 404");
    });
  });
  app.get("/file-abort", (_req: Request, res: Response) => {
    res.sendFile(join(root, "big.bin"), (error) => {
      sendFileResults.push(error ? "aborted" : "finished");
    });
  });
  app.get("/file-null-byte", (_req: Request, res: Response) => {
    res.sendFile("a\0b", { root });
  });
  app.get("/file-relative", (_req: Request, res: Response) => {
    res.sendFile("relative.txt");
  });
  app.get("/file-empty-path", (_req: Request, res: Response) => {
    res.sendFile("");
  });
  app.get("/download/default", (_req: Request, res: Response) => {
    res.download(join(root, "data.json"));
  });
  app.get("/download/options", (_req: Request, res: Response) => {
    res.download("data.json", "report.json", { root, headers: { "X-Extra": "1" } }, () => {
      sendFileResults.push("download done");
    });
  });
  app.get("/download/callback-only", (_req: Request, res: Response) => {
    res.download(join(root, "data.json"), () => {
      sendFileResults.push("download callback");
    });
  });

  api = await start(app);
});

afterAll(async () => {
  await api.close();
});

describe("status and send", () => {
  it("rejects invalid status codes", async () => {
    expect((await api.send("/status/abc")).status).toBe(500);
    expect((await api.send("/status/42")).status).toBe(500);
    expect((await api.send("/status/1000")).status).toBe(500);
  });

  it("sends buffers and typed arrays as octet-stream", async () => {
    const buffer = await api.send("/send/buffer");
    expect(buffer.headers["content-type"]).toBe("application/octet-stream");
    expect(buffer.text).toBe("raw");
    expect((await api.send("/send/typed-array")).text).toBe("hi");
  });

  it("sends empty bodies for null and undefined", async () => {
    expect((await api.send("/send/null")).text).toBe("");
    expect((await api.send("/send/undefined")).text).toBe("");
  });

  it("drops the body for 205", async () => {
    const reply = await api.send("/send/205");
    expect(reply.status).toBe(205);
    expect(reply.text).toBe("");
  });

  it("ignores send() after the response ended", async () => {
    expect((await api.send("/send/twice")).text).toBe("first");
  });

  it("sendStatus sends the status text", async () => {
    const reply = await api.send("/send-status");
    expect(reply.status).toBe(418);
    expect(reply.text).toBe("I'm a Teapot");
  });

  it("json uses the json spaces setting and handles undefined", async () => {
    expect((await api.send("/json-spaces")).text).toBe('{\n  "a": 1\n}');
    expect((await api.send("/json-undefined")).text).toBe("");
  });
});

describe("headers", () => {
  it("set rejects arrays for Content-Type and missing values", async () => {
    expect((await api.send("/set-content-type-array")).status).toBe(500);
    expect((await api.send("/set-missing-value")).status).toBe(500);
  });

  it("type ignores empty values and falls back to octet-stream", async () => {
    expect((await api.send("/type")).headers["content-type"]).toBe("application/octet-stream");
  });

  it("links appends to the Link header", async () => {
    expect((await api.send("/links")).headers.link).toBe(
      '</p/2>; rel="next", </a>; rel="alternate", </b>; rel="alternate", </p/9>; rel="last"',
    );
  });

  it("vary de-duplicates fields and respects *", async () => {
    expect((await api.send("/vary")).headers.vary).toBe("accept, origin, cookie");
    expect((await api.send("/vary-star")).headers.vary).toBe("*");
  });

  it("append keeps previous values", async () => {
    expect((await api.send("/append")).headers["x-list"]).toBe("a, b, c, d");
  });

  it("attachment without a file name", async () => {
    expect((await api.send("/attachment")).headers["content-disposition"]).toBe("attachment");
  });
});

describe("redirect", () => {
  it("supports HEAD and custom statuses", async () => {
    const reply = await api.send("/redirect/head", { method: "HEAD" });
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe("/elsewhere");
    expect(reply.text).toBe("");
  });

  it("sends a text body by default", async () => {
    const reply = await api.send("/redirect/head", { headers: { Accept: "text/plain" } });
    expect(reply.text).toBe("See Other. Redirecting to /elsewhere");
  });

  it("sends no body for unsupported Accept types", async () => {
    const reply = await api.send("/redirect/head", { headers: { Accept: "image/png" } });
    expect(reply.text).toBe("");
  });

  it("requires a URL and ignores redirects after the response ended", async () => {
    expect((await api.send("/redirect/missing")).status).toBe(500);
    expect((await api.send("/redirect/after-send")).text).toBe("done");
  });
});

describe("cookies", () => {
  it("serializes every attribute", async () => {
    const cookies = (await api.send("/cookies/set")).headers["set-cookie"]!;
    expect(cookies[0]).toMatch(
      /^prefs=j%3A%7B%22dark%22%3Atrue%7D; Max-Age=60; Expires=.+; Domain=example.com; Path=\/app; HttpOnly; Secure; Partitioned; Priority=High; SameSite=Lax$/,
    );
    expect(cookies[1]).toBe("strict=1; Path=/; SameSite=Strict");
    expect(cookies[2]).toBe("old=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("requires a secret for signed cookies and valid names", async () => {
    expect((await api.send("/cookies/unsigned-secret")).status).toBe(500);
    expect((await api.send("/cookies/bad-name")).status).toBe(500);
  });
});

describe("format", () => {
  it("picks the handler for the Accept header", async () => {
    const reply = await api.send("/format", { headers: { Accept: "text/plain" } });
    expect(reply.text).toBe("text");
    expect(reply.headers.vary).toBe("accept");
  });

  it("falls back to default, or 406 without one", async () => {
    expect((await api.send("/format", { headers: { Accept: "image/png" } })).status).toBe(299);
    expect((await api.send("/format/none", { headers: { Accept: "image/png" } })).status).toBe(406);
  });
});

describe("sendFile", () => {
  it("sets caching headers and custom headers", async () => {
    const reply = await api.send("/file/data.json");
    expect(reply.text).toBe('{"ok":true}');
    expect(reply.headers["cache-control"]).toBe("public, max-age=3600, immutable");
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(reply.headers["x-served"]).toBe("yes");
  });

  it("answers 304 for If-Modified-Since and If-None-Match", async () => {
    const first = await api.send("/file/data.json");
    const byDate = await api.send("/file/data.json", {
      headers: { "If-Modified-Since": first.headers["last-modified"]! },
    });
    const byTag = await api.send("/file/data.json", {
      headers: { "If-None-Match": first.headers.etag! },
    });
    expect(byDate.status).toBe(304);
    expect(byTag.status).toBe(304);
    expect(byTag.text).toBe("");
  });

  it("ignores conditional headers with Cache-Control: no-cache", async () => {
    const first = await api.send("/file/data.json");
    const reply = await api.send("/file/data.json", {
      headers: { "If-None-Match": first.headers.etag!, "Cache-Control": "no-cache" },
    });
    expect(reply.status).toBe(200);
  });

  it("answers HEAD without a body and serves empty files", async () => {
    const head = await api.send("/file/data.json", { method: "HEAD" });
    expect(head.headers["content-length"]).toBe("11");
    expect(head.text).toBe("");

    const empty = await api.send("/file/empty.txt");
    expect(empty.status).toBe(200);
    expect(empty.headers["content-length"]).toBe("0");
  });

  it("can disable every optional header", async () => {
    const reply = await api.send("/file-plain/unknown.zzz", { headers: { Range: "bytes=0-0" } });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    expect(reply.headers["cache-control"]).toBeUndefined();
    expect(reply.headers["last-modified"]).toBeUndefined();
    expect(reply.headers.etag).toBeUndefined();
    expect(reply.headers["accept-ranges"]).toBeUndefined();
  });

  it("applies the dotfiles policy", async () => {
    expect((await api.send("/file-plain/.hidden/file.txt")).status).toBe(404);
    expect((await api.send("/file-plain/.hidden/file.txt?dotfiles=deny")).status).toBe(403);
    expect((await api.send("/file-plain/.hidden/file.txt?dotfiles=allow")).text).toBe("hidden");
  });

  it("answers 404 for directories and 400 for null bytes", async () => {
    expect((await api.send("/file-plain/dir")).status).toBe(404);
    expect((await api.send("/file-null-byte")).status).toBe(400);
  });

  it("requires an absolute path or a root", async () => {
    expect((await api.send("/file-relative")).status).toBe(500);
    expect((await api.send("/file-empty-path")).status).toBe(500);
  });

  it("passes success and errors to the callback", async () => {
    sendFileResults.length = 0;
    expect((await api.send("/file-callback/data.json")).status).toBe(200);
    const missing = await api.send("/file-callback/missing.txt");
    expect(missing.text).toBe("custom 404");
    expect(sendFileResults).toEqual(["ok", "error:ENOENT"]);
  });

  it("closes the file and reports an error when the client disconnects", async () => {
    sendFileResults.length = 0;
    await api.send("/file-abort", { abortAfter: 1 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendFileResults).toEqual(["aborted"]);
  });
});

describe("download", () => {
  it("uses the file name by default", async () => {
    const reply = await api.send("/download/default");
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="data.json"');
  });

  it("accepts a name, options and a callback", async () => {
    sendFileResults.length = 0;
    const reply = await api.send("/download/options");
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="report.json"');
    expect(reply.headers["x-extra"]).toBe("1");

    await api.send("/download/callback-only");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sendFileResults).toEqual(["download done", "download callback"]);
  });
});
