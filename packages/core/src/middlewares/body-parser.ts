import { Middleware } from "../types/middleware";
import { Request } from "../core/request";
import { parseQuery } from "../utils/helpers";

/** Options shared by all body parsers. */
export interface BodyParserOptions {
  /** Max body size in bytes, or a string like `"100kb"` or `"1mb"`. Default `"100kb"`. */
  limit?: number | string;
  /** Content types to parse, or a predicate. Defaults depend on the parser. */
  type?: string | string[] | ((req: Request) => boolean);
}

/** Options for {@link json}. */
export interface JsonOptions extends BodyParserOptions {
  /** Only accept objects and arrays. Default `true`. */
  strict?: boolean;
}

/** Body parsing error, shaped like `http-errors` so error middleware can read `status` and `expose`. */
class BodyParseError extends Error {
  expose = true;

  /**
   * @param status - HTTP status code, 400, 413 or 415.
   * @param message - Error message, exposed to the client.
   * @param type - Machine-readable error type, same values as `body-parser`.
   */
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

/** Multipliers for the units accepted by {@link parseBytes}. */
const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

/**
 * Converts a size limit like `"100kb"` to bytes.
 *
 * @throws When the string isn't a number with an optional b/kb/mb/gb unit.
 */
function parseBytes(limit: number | string): number {
  if (typeof limit === "number") return limit;

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!match) throw new TypeError(`Invalid body size limit: ${limit}`);

  return Math.floor(parseFloat(match[1]) * UNITS[(match[2] || "b").toLowerCase()]);
}

/**
 * Reads the whole request body.
 *
 * @param limit - Max body size in bytes.
 * @returns The body, or rejects with a 413 error when it exceeds `limit`.
 */
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

/**
 * Creates a body-parsing middleware. Errors go to `next(err)` so error
 * middleware can handle them, as with Express's `body-parser`. Requests
 * whose body was already parsed (`req._body` or `req.body` set) or whose
 * stream was already read, e.g. by the `body-parser` package, are skipped;
 * waiting on an ended stream would hang the request.
 *
 * @param defaultType - Content type parsed when `options.type` is not set.
 * @param options - Parser options.
 * @param parse - Turns the raw body into `req.body`.
 */
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

  return async (req, _res, next) => {
    if (req._body || req.body !== undefined || req.readableEnded || !shouldParse(req)) {
      return next();
    }

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

/**
 * Parses `application/json` bodies into `req.body`. An empty body becomes `{}`,
 * a whitespace-only body is a 400 like `body-parser`.
 */
export function json(options: JsonOptions = {}): Middleware {
  const strict = options.strict ?? true;

  return createParser("json", options, (body) => {
    if (body.length === 0) return {};
    const text = body.toString("utf8");

    if (strict && !/^\s*[{[]/.test(text)) {
      if (text.trim() === "") throw new BodyParseError(400, "Unexpected end of JSON input");
      throw new BodyParseError(400, "JSON body must be an object or array");
    }

    return JSON.parse(text);
  });
}

/** Parses `application/x-www-form-urlencoded` bodies. Repeated keys become arrays. */
export function urlencoded(options: BodyParserOptions = {}): Middleware {
  return createParser("urlencoded", options, (body) =>
    parseQuery(body.toString("utf8")),
  );
}

/** Reads `text/plain` bodies into `req.body` as a string. */
export function text(options: BodyParserOptions = {}): Middleware {
  return createParser("text/plain", options, (body) => body.toString("utf8"));
}

/** Reads `application/octet-stream` bodies into `req.body` as a `Buffer`. */
export function raw(options: BodyParserOptions = {}): Middleware {
  return createParser("application/octet-stream", options, (body) => body);
}
