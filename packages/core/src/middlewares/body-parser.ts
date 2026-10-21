import { Transform } from "stream";
import { createBrotliDecompress, createGunzip, createInflate } from "zlib";
import { Middleware } from "../types/middleware";
import { Request } from "../core/request";
import type { Response } from "../core/response";
import { parseQs } from "../utils/qs";

/** Options shared by all body parsers. */
export interface BodyParserOptions {
  /** Max body size in bytes, or a string like `"100kb"` or `"1mb"`. Default `"100kb"`. */
  limit?: number | string;
  /** Content types to parse, or a predicate. Defaults depend on the parser. */
  type?: string | string[] | ((req: Request) => boolean);
  /** Decompress `gzip`, `deflate` and `br` bodies. Default `true`; with `false` they are a 415. */
  inflate?: boolean;
  /** Charset when the `Content-Type` has none. Default `"utf-8"`. */
  defaultCharset?: string;
  /**
   * Called with the raw (decompressed) body before it is parsed. Throw to
   * reject the request with a 403, `type` defaults to `entity.verify.failed`.
   */
  verify?: (req: Request, res: Response, body: Buffer, charset: string | null) => void;
}

/** Options for {@link json}. */
export interface JsonOptions extends BodyParserOptions {
  /** Only accept objects and arrays. Default `true`. */
  strict?: boolean;
  /** Passed to `JSON.parse`. */
  reviver?: (this: any, key: string, value: any) => any;
}

/** Options for {@link urlencoded}. */
export interface UrlencodedOptions extends BodyParserOptions {
  /** Parse nested keys like `a[b]=c` and arrays like `a[]=1`. Default `false`. */
  extended?: boolean;
  /** Max parameters, more is a 413. Default 1000. */
  parameterLimit?: number;
  /** Max nesting depth with `extended`, deeper is a 400. Default 32. */
  depth?: number;
  /** Read the charset from a `utf8=` parameter. Default `false`. */
  charsetSentinel?: boolean;
  /** Decode `&#nnn;` entities in ISO-8859-1 bodies. Default `false`. */
  interpretNumericEntities?: boolean;
  /** `"utf-8"` or `"iso-8859-1"`. Default `"utf-8"`. */
  defaultCharset?: "utf-8" | "iso-8859-1";
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

/** Decompressors for the encodings `body-parser` inflates. */
const DECOMPRESSORS: Record<string, () => Transform> = {
  gzip: createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};

/**
 * Reads the whole request body, decompressing it for a `Content-Encoding`
 * other than `identity`.
 *
 * `limit` applies to the decompressed bytes and reading stops as soon as it
 * is passed, so a small compressed body can't expand without bound. A
 * declared `Content-Length` above the limit is rejected before reading, for
 * uncompressed bodies only.
 *
 * @param limit - Max body size in bytes.
 * @param encoding - The lower-cased `Content-Encoding`, `identity` or a key of {@link DECOMPRESSORS}.
 * @returns The body. Rejects with a 413 when it exceeds `limit`, a 400
 * `request.aborted` when the client disconnects first, like `raw-body`, and a
 * 400 without `type` when the compressed data is invalid, like `body-parser`.
 */
function readBody(req: Request, limit: number, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (encoding === "identity" && !Number.isNaN(declared) && declared > limit) {
      return afterRequest(req, () => reject(tooLarge(limit, declared)));
    }

    const decompressor = encoding === "identity" ? null : DECOMPRESSORS[encoding]();
    const stream = decompressor ?? req;
    if (decompressor) req.pipe(decompressor);

    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const cleanup = () => {
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onStreamError);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
      if (decompressor) {
        req.unpipe(decompressor);
        decompressor.destroy();
      }
    };

    // Like body-parser, the rest of the request is read off first, so the
    // error answer doesn't arrive while the client is still sending, and the
    // connection can be reused.
    const fail = (error: BodyParseError) => {
      cleanup();
      afterRequest(req, () => reject(error));
    };

    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) return fail(tooLarge(limit, received));
      chunks.push(chunk);
    };

    const onEnd = () => {
      // Like raw-body: a body that isn't as long as Content-Length says.
      if (!decompressor && !Number.isNaN(declared) && received !== declared) {
        return fail(
          Object.assign(new BodyParseError(400, "request size did not match content length", "request.size.invalid"), {
            expected: declared,
            length: declared,
            received,
          }),
        );
      }
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (error: Error) => {
      if (settled) return;
      fail(req.aborted ? aborted(received) : new BodyParseError(400, error.message));
    };

    const onStreamError = (error: Error) => {
      if (settled) return;
      if (!decompressor) return onError(error);
      fail(Object.assign(new BodyParseError(400, error.message), { type: undefined }));
    };

    const onClose = () => {
      if (settled || req.complete) return;
      fail(aborted(received));
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onStreamError);
    if (decompressor) req.on("error", onError);
    req.on("close", onClose);
  });
}

/** A 400 for a client that disconnected mid-body, like `raw-body`. */
/** Reads off the rest of a request, then calls `done`, like body-parser's dump(). */
function afterRequest(req: Request, done: () => void) {
  if (req.complete || req.readableEnded || req.destroyed) return done();
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    req.removeListener("end", once);
    req.removeListener("close", once);
    done();
  };
  req.on("end", once);
  req.on("close", once);
  req.resume();
}

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
  if (charset === "utf-16" || charset === "utf16") return new TextDecoder(utf16Endianness(body)).decode(body);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return null;
  }
}

/** UTF-32 names; TextDecoder has no UTF-32, `iconv-lite` does. */
const UTF32 = new Set(["utf-32", "utf32", "utf-32le", "utf32le", "utf-32be", "utf32be"]);

/**
 * The byte order of a "utf-16" body, like iconv-lite: from a byte order
 * mark, else from where the zero bytes of ASCII characters are in its first
 * 64 bytes, little-endian when that doesn't tell.
 */
function utf16Endianness(body: Buffer): "utf-16be" | "utf-16le" {
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  let big = 0;
  let little = 0;
  const end = Math.min(body.length - (body.length % 2), 64);
  for (let i = 0; i < end; i += 2) {
    if (body[i] === 0 && body[i + 1] !== 0) big++;
    if (body[i] !== 0 && body[i + 1] === 0) little++;
  }
  return big > little ? "utf-16be" : "utf-16le";
}

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
  const inflate = options.inflate !== false;
  const defaultCharset = options.defaultCharset || "utf-8";
  const verify = options.verify;
  if (verify !== undefined && typeof verify !== "function") {
    throw new TypeError("option verify must be function");
  }
  const type = options.type ?? config.defaultType;
  const shouldParse =
    typeof type === "function"
      ? type
      : (req: Request) => Boolean(req.is(...[type].flat()));

  return async (req, res, next) => {
    // Like body-parser, requests without a body are skipped before a type
    // function is asked.
    if (req._body || req.body !== undefined || req.readableEnded || !hasBody(req) || !shouldParse(req)) {
      return next();
    }

    const charset = charsetOf(req.headers["content-type"]) || defaultCharset;
    if (config.isValidCharset && !config.isValidCharset(charset)) {
      return next(unsupportedCharset(charset));
    }

    const encoding = (
      req.headers["content-encoding"] || "identity"
    ).toLowerCase();
    if (encoding !== "identity" && (!inflate || !DECOMPRESSORS[encoding])) {
      const message = inflate ? `unsupported content encoding "${encoding}"` : "content encoding unsupported";
      return next(Object.assign(new BodyParseError(415, message, "encoding.unsupported"), { encoding }));
    }

    // Like body-parser, verify only sees bodies whose charset can be decoded.
    if (verify && config.isValidCharset && decode(Buffer.alloc(0), charset) === null) {
      return next(unsupportedCharset(charset));
    }

    let body: unknown;
    let decoded: string | Buffer | null = null;
    try {
      const raw = await readBody(req, limit, encoding);

      if (verify) {
        try {
          verify(req, res, raw, config.isValidCharset ? charset : null);
        } catch (error) {
          // Like body-parser, a status the error has wins over 403.
          const verifyError = error as Error & { type?: string; status?: number; statusCode?: number };
          const status = validStatus(verifyError.status ?? verifyError.statusCode) ?? 403;
          return next(
            Object.assign(new BodyParseError(status, verifyError.message, verifyError.type || "entity.verify.failed"), {
              body: raw,
              expose: status < 500,
            }),
          );
        }
      }

      decoded = config.isValidCharset ? decode(raw, charset) : raw;
      if (decoded === null) return next(unsupportedCharset(charset));
      body = parse(decoded, charset);
    } catch (error) {
      const parseError =
        error instanceof BodyParseError ? error : new BodyParseError(400, (error as Error).message);
      // Like body-parser, a body that fails to parse is on the error.
      if (decoded !== null && parseError.body === undefined) parseError.body = decoded;
      return next(parseError);
    }

    req._body = true;
    req.body = body;
    next();
  };
}

/** First non-whitespace character, the check `body-parser` uses for strict mode. */
/** Whether a request has a body, like type-is: a Transfer-Encoding or a numeric Content-Length. */
function hasBody(req: Request) {
  return req.headers["transfer-encoding"] !== undefined || !Number.isNaN(Number(req.headers["content-length"] ?? NaN));
}

/** An HTTP error status, `undefined` for anything else. */
function validStatus(status: unknown) {
  return typeof status === "number" && status >= 400 && status < 600 ? status : undefined;
}

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
export function json(opts?: JsonOptions): Middleware {
  const options = opts ?? {};
  const strict = options.strict ?? true;
  const config = { defaultType: "json", isValidCharset: (charset: string) => charset.startsWith("utf-") };

  return createParser(config, options, (body) => {
    const text = body as string;
    if (text.length === 0) return {};

    if (strict) {
      const first = FIRST_CHAR.exec(text)?.[1];
      if (first !== "{" && first !== "[") throw strictError(text, first);
    }

    return JSON.parse(text, options.reviver);
  });
}

/**
 * Parses `application/x-www-form-urlencoded` bodies like `body-parser`, with
 * the rules of `qs`. Without `extended`, keys are flat: repeated keys become
 * arrays, a key wrapped in brackets loses them and `[]` keys become `0`,
 * `1`, ...; with `extended`, `a[b]=c` and `a[]=1` build nested objects and
 * arrays. More than `parameterLimit` parameters is a 413, keys deeper than
 * `depth` a 400. Empty and `__proto__` keys are dropped and objects have no
 * prototype. Charsets: UTF-8 and ISO-8859-1, otherwise 415.
 *
 * @throws When `defaultCharset`, `parameterLimit` or `depth` is invalid.
 */
export function urlencoded(opts?: UrlencodedOptions): Middleware {
  const options = opts ?? {};
  const defaultCharset = options.defaultCharset || "utf-8";
  if (defaultCharset !== "utf-8" && defaultCharset !== "iso-8859-1") {
    throw new TypeError("option defaultCharset must be either utf-8 or iso-8859-1");
  }

  const extended = Boolean(options.extended);
  let parameterLimit = options.parameterLimit ?? 1000;
  const depth = extended ? (options.depth ?? 32) : 0;
  // Like body-parser, anything that isn't a number, "foo" included, is rejected.
  if (Number.isNaN(Number(parameterLimit)) || parameterLimit < 1) {
    throw new TypeError("option parameterLimit must be a positive number");
  }
  if (Number.isNaN(Number(depth)) || depth < 0) {
    throw new TypeError("option depth must be a zero or a positive number");
  }
  if (Number.isFinite(parameterLimit)) parameterLimit = parameterLimit | 0;

  const config = {
    defaultType: "urlencoded",
    isValidCharset: (charset: string) => charset === "utf-8" || charset === "iso-8859-1",
  };

  return createParser(config, { ...options, defaultCharset }, (body, charset) => {
    const text = body as string;
    if (text.length === 0) return Object.create(null);

    const count = text.split("&").length;
    if (count > parameterLimit) {
      throw new BodyParseError(413, "too many parameters", "parameters.too.many");
    }

    try {
      return parseQs(text, {
        arrayLimit: extended ? Math.max(100, count) : count,
        depth,
        charsetSentinel: options.charsetSentinel,
        interpretNumericEntities: options.interpretNumericEntities,
        charset: charset as "utf-8" | "iso-8859-1",
        parameterLimit,
        strictDepth: true,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BodyParseError(400, "The input exceeded the depth", "querystring.parse.rangeError");
      }
      throw error;
    }
  });
}

/** Reads `text/plain` bodies into `req.body` as a string, in any charset Node can decode. */
export function text(options?: BodyParserOptions): Middleware {
  return createParser({ defaultType: "text/plain", isValidCharset: () => true }, options ?? {}, (body) => body);
}

/** Reads `application/octet-stream` bodies into `req.body` as a `Buffer`. */
export function raw(options?: BodyParserOptions): Middleware {
  return createParser({ defaultType: "application/octet-stream", isValidCharset: null }, options ?? {}, (body) => body);
}
