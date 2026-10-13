import { Middleware } from "../types/middleware";
import { Request } from "../core/request";
import { parseQuery } from "../utils/helpers";

export interface BodyParserOptions {
  // Max body size in bytes, or a string like "100kb" / "1mb". Default "100kb".
  limit?: number | string;
  // Content types to parse, or a predicate. Defaults depend on the parser.
  type?: string | string[] | ((req: Request) => boolean);
}

export interface JsonOptions extends BodyParserOptions {
  // Only accept objects and arrays (default true).
  strict?: boolean;
}

// Shaped like http-errors so error middleware can read status/expose.
class BodyParseError extends Error {
  expose = true;

  constructor(
    public status: number,
    message: string,
    public type = "entity.parse.failed",
  ) {
    super(message);
    this.statusCode = status;
  }

  statusCode: number;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

function parseBytes(limit: number | string): number {
  if (typeof limit === "number") return limit;

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!match) throw new TypeError(`Invalid body size limit: ${limit}`);

  return Math.floor(parseFloat(match[1]) * UNITS[(match[2] || "b").toLowerCase()]);
}

function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (!Number.isNaN(declared) && declared > limit) {
      req.resume();
      return reject(
        new BodyParseError(413, "Request entity too large", "entity.too.large"),
      );
    }

    const chunks: Buffer[] = [];
    let received = 0;

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        req.removeAllListeners("data");
        req.resume();
        reject(
          new BodyParseError(413, "Request entity too large", "entity.too.large"),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function createParser(
  defaultType: string,
  options: BodyParserOptions,
  parse: (body: Buffer) => any,
): Middleware {
  const limit = parseBytes(options.limit ?? "100kb");
  const type = options.type ?? defaultType;
  const shouldParse =
    typeof type === "function"
      ? type
      : (req: Request) => Boolean(req.is(...[type].flat()));

  // Errors go to next(err) so error middleware can handle them, as with
  // Express's body-parser.
  return async (req, _res, next) => {
    if (req._body || !shouldParse(req)) return next();

    const encoding = (
      req.headers["content-encoding"] || "identity"
    ).toLowerCase();
    if (encoding !== "identity") {
      return next(
        new BodyParseError(
          415,
          `Unsupported content encoding "${encoding}"`,
          "encoding.unsupported",
        ),
      );
    }

    let body: any;
    try {
      body = parse(await readBody(req, limit));
    } catch (error) {
      return next(
        error instanceof BodyParseError
          ? error
          : new BodyParseError(400, (error as Error).message),
      );
    }

    req._body = true;
    req.body = body;
    next();
  };
}

export function json(options: JsonOptions = {}): Middleware {
  const strict = options.strict ?? true;

  return createParser("json", options, (body) => {
    const text = body.toString("utf8");
    if (text.trim() === "") return {};

    if (strict && !/^\s*[{[]/.test(text)) {
      throw new BodyParseError(400, "JSON body must be an object or array");
    }

    return JSON.parse(text);
  });
}

export function urlencoded(options: BodyParserOptions = {}): Middleware {
  return createParser("urlencoded", options, (body) =>
    parseQuery(body.toString("utf8")),
  );
}

export function text(options: BodyParserOptions = {}): Middleware {
  return createParser("text/plain", options, (body) => body.toString("utf8"));
}

export function raw(options: BodyParserOptions = {}): Middleware {
  return createParser("application/octet-stream", options, (body) => body);
}
