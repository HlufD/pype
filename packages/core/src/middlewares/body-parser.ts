import { Middleware } from "../types/middleware";
import { Request } from "../core/request";

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
  [key: string]: unknown;

  /**
   * @param status - HTTP status code, 400, 413 or 415.
   * @param message - Error message, exposed to the client, same wording as `body-parser`.
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

/** Turns the decoded body into `req.body`. */
type Parse = (body: string | Buffer, charset: string) => unknown;

/** How a parser reads the body. */
interface ParserConfig {
  /** Content type parsed when `options.type` is not set. */
  defaultType: string;
  /** Charsets the parser accepts, `null` for raw bytes. */
  isValidCharset: ((charset: string) => boolean) | null;
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
 * @throws When the string isn't a number with an optional b/kb/mb/gb unit,
 * or the number is `NaN` (it would disable the limit). Same as `body-parser`.
 */
function parseBytes(limit: number | string): number {
  if (typeof limit === "number") {
    if (Number.isNaN(limit)) throw new TypeError(`Invalid body size limit: ${limit}`);
    return limit;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!match) throw new TypeError(`Invalid body size limit: ${limit}`);

  return Math.floor(parseFloat(match[1]) * UNITS[(match[2] || "b").toLowerCase()]);
}

/** A 413 like `raw-body` gives. */
function tooLarge(limit: number, length: number) {
  return Object.assign(new BodyParseError(413, "request entity too large", "entity.too.large"), {
    limit,
    length,
  });
}

/**
 * Reads the whole request body.
 *
 * @param limit - Max body size in bytes.
 * @returns The body. Rejects with a 413 when it exceeds `limit` and with a
 * 400 `request.aborted` when the client disconnects first, like `raw-body`.
 */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (!Number.isNaN(declared) && declared > limit) {
      req.resume();
      return reject(tooLarge(limit, declared));
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const cleanup = () => {
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        cleanup();
        req.resume();
        reject(tooLarge(limit, received));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (error: Error) => {
      if (settled) return;
      cleanup();
      reject(req.aborted ? aborted(received) : new BodyParseError(400, error.message));
    };

    const onClose = () => {
      if (settled || req.complete) return;
      cleanup();
      reject(aborted(received));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/** A 400 for a client that disconnected mid-body, like `raw-body`. */
function aborted(received: number) {
  return Object.assign(new BodyParseError(400, "request aborted", "request.aborted"), {
    code: "ECONNABORTED",
    received,
  });
}

/** The lower-cased `charset` parameter of a `Content-Type`. */
function charsetOf(header: string | undefined): string | undefined {
  const match = /;\s*charset\s*=\s*("?)([^";]*)\1/i.exec(header || "");
  return match ? match[2].trim().toLowerCase() : undefined;
}

/** Names of ISO-8859-1, decoded byte for byte like `iconv-lite` (TextDecoder maps them to windows-1252). */
const LATIN1 = new Set(["iso-8859-1", "iso8859-1", "iso88591", "latin1", "l1", "binary"]);

/**
 * Decodes a body in `charset`. A leading byte order mark is dropped, like
 * `iconv-lite` does.
 *
 * @returns `null` when Node can't decode the charset.
 */
function decode(body: Buffer, charset: string): string | null {
  if (LATIN1.has(charset)) return body.toString("latin1");
  if (UTF32.has(charset)) return decodeUtf32(body, charset);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return null;
  }
}

/** UTF-32 names; TextDecoder has no UTF-32, `iconv-lite` does. */
const UTF32 = new Set(["utf-32", "utf32", "utf-32le", "utf32le", "utf-32be", "utf32be"]);

/**
 * Decodes UTF-32 like `iconv-lite`: the byte order comes from the name or a
 * byte order mark (which is dropped), little-endian by default. Invalid code
 * points become U+FFFD.
 */
function decodeUtf32(body: Buffer, charset: string): string {
  let bigEndian = charset.endsWith("be");
  let start = 0;

  if (!charset.endsWith("le") && !bigEndian && body.length >= 4) {
    if (body.readUInt32BE(0) === 0xfeff) [bigEndian, start] = [true, 4];
    else if (body.readUInt32LE(0) === 0xfeff) start = 4;
  } else if (body.length >= 4 && (bigEndian ? body.readUInt32BE(0) : body.readUInt32LE(0)) === 0xfeff) {
    start = 4;
  }

  let text = "";
  for (let i = start; i + 4 <= body.length; i += 4) {
    const point = bigEndian ? body.readUInt32BE(i) : body.readUInt32LE(i);
    text += point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "\ufffd" : String.fromCodePoint(point);
  }
  if ((body.length - start) % 4 !== 0) text += "\ufffd";
  return text;
}

/** A 415 for a charset the parser doesn't accept, like `body-parser`. */
function unsupportedCharset(charset: string) {
  return Object.assign(
    new BodyParseError(415, `unsupported charset "${charset.toUpperCase()}"`, "charset.unsupported"),
    { charset },
  );
}

/**
 * Creates a body-parsing middleware. Errors go to `next(err)` so error
 * middleware can handle them, as with Express's `body-parser`. Requests
 * whose body was already parsed (`req._body` or `req.body` set) or whose
 * stream was already read, e.g. by the `body-parser` package, are skipped;
 * waiting on an ended stream would hang the request.
 *
 * @param config - Default type and accepted charsets.
 * @param options - Parser options.
 * @param parse - Turns the decoded body into `req.body`.
 */
function createParser(
  config: ParserConfig,
  options: BodyParserOptions,
  parse: Parse,
): Middleware {
  const limit = parseBytes(options.limit ?? "100kb");
  const type = options.type ?? config.defaultType;
  const shouldParse =
    typeof type === "function"
      ? type
      : (req: Request) => Boolean(req.is(...[type].flat()));

  return async (req, _res, next) => {
    if (req._body || req.body !== undefined || req.readableEnded || !shouldParse(req)) {
      return next();
    }

    const charset = charsetOf(req.headers["content-type"]) || "utf-8";
    if (config.isValidCharset && !config.isValidCharset(charset)) {
      return next(unsupportedCharset(charset));
    }

    const encoding = (
      req.headers["content-encoding"] || "identity"
    ).toLowerCase();
    if (encoding !== "identity") {
      return next(
        Object.assign(
          new BodyParseError(415, `unsupported content encoding "${encoding}"`, "encoding.unsupported"),
          { encoding },
        ),
      );
    }

    let body: unknown;
    try {
      const raw = await readBody(req, limit);
      const decoded = config.isValidCharset ? decode(raw, charset) : raw;
      if (decoded === null) return next(unsupportedCharset(charset));
      body = parse(decoded, charset);
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

/** First non-whitespace character, the check `body-parser` uses for strict mode. */
const FIRST_CHAR = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/;

/**
 * The error `body-parser` gives for a strict-mode violation: what
 * `JSON.parse` reports at the offending character, e.g.
 * `Unexpected token '"', ""str"" is not valid JSON`.
 */
function strictError(text: string, first: string | undefined) {
  const index = first === undefined ? -1 : text.indexOf(first);
  const partial = index === -1 ? "" : text.slice(0, index) + "#".repeat(text.length - index);
  try {
    JSON.parse(partial);
  } catch (error) {
    const message = (error as Error).message.replace(/#+/g, (placeholder) =>
      text.slice(index, index + placeholder.length),
    );
    return new BodyParseError(400, message);
  }
  return new BodyParseError(400, "strict violation");
}

/**
 * Parses `application/json` bodies into `req.body`, like `body-parser`. An
 * empty body becomes `{}`, a whitespace-only one is a 400. The charset must
 * be a UTF variant, otherwise 415.
 */
export function json(options: JsonOptions = {}): Middleware {
  const strict = options.strict ?? true;
  const config = { defaultType: "json", isValidCharset: (charset: string) => charset.startsWith("utf-") };

  return createParser(config, options, (body) => {
    const text = body as string;
    if (text.length === 0) return {};

    if (strict) {
      const first = FIRST_CHAR.exec(text)?.[1];
      if (first !== "{" && first !== "[") throw strictError(text, first);
    }

    return JSON.parse(text);
  });
}

/**
 * Parses `application/x-www-form-urlencoded` bodies like `body-parser` with
 * `extended: false`: repeated keys become arrays, `+` is a space, empty keys
 * and `__proto__` are dropped, and more than 1000 parameters is a 413. The
 * result has no prototype. Charsets: UTF-8 and ISO-8859-1, otherwise 415.
 */
export function urlencoded(options: BodyParserOptions = {}): Middleware {
  const config = {
    defaultType: "urlencoded",
    isValidCharset: (charset: string) => charset === "utf-8" || charset === "iso-8859-1",
  };
  return createParser(config, options, (body, charset) => parseForm(body as string, charset));
}

/** Max number of parameters in a form body, `body-parser`'s default `parameterLimit`. */
const PARAMETER_LIMIT = 1000;

/** A form value: repeated keys collect their values in an array. */
type FormValue = string | string[];

/**
 * Parses a form body with the rules of `qs` at depth 0, which `body-parser`
 * uses for `extended: false`: values of repeated keys are collected, a key
 * wrapped in brackets loses them (`[a]` is `a`), `[]` keys become the
 * indexes `0`, `1`, ..., and empty or `__proto__` keys are dropped.
 */
function parseForm(body: string, charset: string): Record<string, FormValue> {
  const form: Record<string, FormValue> = Object.create(null);
  if (body.length === 0) return form;

  const parts = body.replace(/%5B/gi, "[").replace(/%5D/gi, "]").split("&");
  if (parts.length > PARAMETER_LIMIT) {
    throw new BodyParseError(413, "too many parameters", "parameters.too.many");
  }

  const values: Record<string, FormValue> = Object.create(null);
  for (const part of parts) {
    // Like qs, a "]=" ends the key, so "a]=b=c" has the key "a]".
    const bracketEquals = part.indexOf("]=");
    const eq = bracketEquals === -1 ? part.indexOf("=") : bracketEquals + 1;
    const key = decodeFormComponent(eq === -1 ? part : part.slice(0, eq), charset);
    const value = eq === -1 ? "" : decodeFormComponent(part.slice(eq + 1), charset);
    values[key] = key in values ? ([] as string[]).concat(values[key], value) : value;
  }

  for (const key of Object.keys(values)) {
    if (key === "") continue;
    const value = values[key];

    if (key === "[]") {
      ([] as string[]).concat(value).forEach((item, index) => mergeFormValue(form, String(index), item));
      continue;
    }

    const name = key.length > 1 && key.startsWith("[") && key.endsWith("]") ? key.slice(1, -1) : key;
    if (name !== "__proto__") mergeFormValue(form, name, value);
  }

  return form;
}

/** Adds a value to a form key, collecting values like `qs`' `merge`. */
function mergeFormValue(form: Record<string, FormValue>, key: string, value: FormValue) {
  const existing = form[key];
  if (existing === undefined) form[key] = value;
  else if (Array.isArray(existing)) existing.push(...([] as string[]).concat(value));
  else form[key] = ([existing] as string[]).concat(value);
}

/** Decodes `+` and percent-escapes, leaving malformed escapes as they are, like `qs`. */
function decodeFormComponent(value: string, charset: string): string {
  const text = value.replace(/\+/g, " ");
  if (charset === "iso-8859-1") {
    return text.replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(parseInt(escape.slice(1), 16)));
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Reads `text/plain` bodies into `req.body` as a string, in any charset Node can decode. */
export function text(options: BodyParserOptions = {}): Middleware {
  return createParser({ defaultType: "text/plain", isValidCharset: () => true }, options, (body) => body);
}

/** Reads `application/octet-stream` bodies into `req.body` as a `Buffer`. */
export function raw(options: BodyParserOptions = {}): Middleware {
  return createParser({ defaultType: "application/octet-stream", isValidCharset: null }, options, (body) => body);
}
