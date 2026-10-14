import { ServerResponse, STATUS_CODES } from "http";
import { createReadStream, stat } from "fs";
import { pipeline } from "stream";
import { basename, extname, isAbsolute, join, resolve, sep } from "path";
import type { Request } from "./request";
import type { Pype } from "./server";
import { MIME_TYPES } from "../enums/mime-types";
import {
  contentDisposition,
  contentType,
  encodeUrl,
  escapeHtml,
  generateETag,
  serializeCookie,
  signCookie,
} from "../utils/helpers";
import { CookieOptions } from "../types/cookie-options";

/** Options for {@link Response.sendFile} and {@link Response.download}. */
export interface SendFileOptions {
  /** Directory relative paths are resolved against; paths may not escape it. */
  root?: string;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** How to treat dotfiles: `"ignore"` (404, default), `"deny"` (403) or `"allow"`. */
  dotfiles?: "allow" | "deny" | "ignore";
  /** `Cache-Control` max-age in milliseconds. Default 0. */
  maxAge?: number;
  /** Adds `immutable` to `Cache-Control`. */
  immutable?: boolean;
  /** Set `Cache-Control`. Default `true`. */
  cacheControl?: boolean;
  /** Set `Last-Modified`. Default `true`. */
  lastModified?: boolean;
  /** Set a weak `ETag`. Default `true`. */
  etag?: boolean;
  /** Support `Range` requests. Default `true`. */
  acceptRanges?: boolean;
}

/** Called when a file transfer finishes or fails. */
type SendFileCallback = (error?: Error) => void;

/** Error carrying an HTTP status, used for file transfer failures. */
class HttpError extends Error {
  /**
   * @param status - HTTP status code.
   * @param message - Defaults to the status code's standard message.
   */
  constructor(
    public status: number,
    message = STATUS_CODES[status] || String(status),
  ) {
    super(message);
  }
}

/** Merges Express response augmentations into {@link Response}. */
export interface Response extends Express.Response {}

/** Express-compatible response, extends Node's `ServerResponse`. */
export class Response extends ServerResponse<Request> {
  /** The app handling the request. */
  app!: Pype;
  /** Values scoped to this request, e.g. for templates or later middleware. */
  locals: Record<string, any> = {};

  /**
   * Sets the status code.
   *
   * @throws When the code isn't an integer between 100 and 999.
   */
  status(code: number) {
    if (!Number.isInteger(code)) {
      throw new TypeError(`Invalid status code: ${code}. Must be an integer.`);
    }
    if (code < 100 || code > 999) {
      throw new RangeError(
        `Invalid status code: ${code}. Must be between 100 and 999.`,
      );
    }

    this.statusCode = code;
    return this;
  }

  /** Sends the status code with its standard message as a plain-text body. */
  sendStatus(code: number) {
    this.status(code);
    this.type("txt");
    return this.send(STATUS_CODES[code] || String(code));
  }

  /**
   * Sends a response body.
   *
   * Strings default to HTML and Buffers to `application/octet-stream`;
   * objects, arrays, numbers and booleans are sent as JSON. Strings stay
   * strings, so Node writes headers and body in one chunk. Sets
   * `Content-Length` and an `ETag`, answers 304 when the client's copy is
   * fresh, and drops the body for HEAD, 204, 205 and 304.
   */
  send(body?: any): this {
    if (this.writableEnded) return this;

    let chunk: string | Buffer | undefined;

    if (typeof body === "string") {
      if (!this.get("Content-Type")) this.type("html");
      chunk = body;
    } else if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
      if (!this.get("Content-Type"))
        this.set("Content-Type", "application/octet-stream");
      chunk = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    } else if (body === null) {
      chunk = "";
    } else if (body !== undefined) {
      return this.json(body);
    }

    if (chunk !== undefined) {
      const length =
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      this.setHeader("Content-Length", length);

      if (this.app?.settings.etag !== false && !this.hasHeader("ETag")) {
        this.setHeader("ETag", generateETag(chunk, length));
      }
    }

    if (this.req.fresh) this.statusCode = 304;

    if (this.statusCode === 204 || this.statusCode === 304) {
      this.removeHeader("Content-Type");
      this.removeHeader("Content-Length");
      this.removeHeader("Transfer-Encoding");
      chunk = undefined;
    }

    if (this.statusCode === 205) {
      this.set("Content-Length", "0");
      this.removeHeader("Transfer-Encoding");
      chunk = undefined;
    }

    if (this.req.method === "HEAD" || chunk === undefined) this.end();
    else this.end(chunk);

    return this;
  }

  /**
   * Sends any JSON value, using the app's `"json replacer"` and
   * `"json spaces"` settings.
   */
  json(data: any): this {
    if (!this.hasHeader("Content-Type"))
      this.setHeader("Content-Type", "application/json; charset=utf-8");

    const body = JSON.stringify(
      data,
      this.app?.settings["json replacer"],
      this.app?.settings["json spaces"],
    );
    return this.send(body === undefined ? "" : body);
  }

  /** Reads a response header. */
  get(field: string) {
    return this.getHeader(field);
  }

  /**
   * Sets one header, or several from an object. `Content-Type` values get a
   * utf-8 charset for text and JSON types.
   *
   * @throws When `value` is missing for a single header, or `Content-Type`
   * is given an array.
   */
  set(field: string | Record<string, string | string[]>, value?: string | string[]) {
    if (typeof field !== "string") {
      for (const key in field) this.set(key, field[key]);
      return this;
    }

    if (value === undefined)
      throw new Error("Value is required when field is a string");

    if (field.toLowerCase() === "content-type") {
      if (Array.isArray(value))
        throw new TypeError("Content-Type cannot be set to an Array");
      value = contentType(value);
    }

    this.setHeader(
      field,
      Array.isArray(value) ? value.map(String) : String(value),
    );
    return this;
  }

  /** Alias of {@link Response.set}. */
  header(field: string | Record<string, string | string[]>, value?: string | string[]) {
    return this.set(field, value);
  }

  /**
   * Sets `Content-Type` from a MIME type or an extension such as `"json"`.
   * Unknown extensions become `application/octet-stream`.
   */
  type(value: string) {
    if (!value) return this;

    const type = value.includes("/")
      ? value
      : MIME_TYPES[value.replace(/^\./, "").toLowerCase()] ||
        "application/octet-stream";

    return this.set("Content-Type", type);
  }

  /**
   * Redirects to `url`, 302 unless a status is given. The URL is encoded and
   * the body is text or HTML depending on the `Accept` header.
   *
   * @throws When no URL is given.
   */
  redirect(url: string): this;
  redirect(status: number, url: string): this;
  redirect(statusOrUrl: number | string, url?: string) {
    if (this.writableEnded) return this;

    let status = 302;
    let address: string;

    if (typeof statusOrUrl === "number") {
      status = statusOrUrl;
      address = url!;
    } else {
      address = statusOrUrl;
    }

    if (!address) throw new TypeError("res.redirect() requires a url");

    this.location(address);
    const location = this.get("Location") as string;
    const statusText = STATUS_CODES[status] || String(status);
    let body = "";

    this.format({
      text: () => {
        body = `${statusText}. Redirecting to ${location}`;
      },
      html: () => {
        const escaped = escapeHtml(location);
        body = `<!DOCTYPE html><head><title>${statusText}</title></head><body><p>${statusText}. Redirecting to <a href="${escaped}">${escaped}</a></p></body>`;
      },
      default: () => {
        body = "";
      },
    });

    this.status(status);
    this.set("Content-Length", String(Buffer.byteLength(body)));

    if (this.req.method === "HEAD") this.end();
    else this.end(body);

    return this;
  }

  /**
   * Appends to the `Link` header.
   *
   * @example res.links({ next: "/users?page=2", last: "/users?page=5" })
   */
  links(links: Record<string, string | string[]>) {
    if (!links || typeof links !== "object") {
      return this;
    }

    const existing = this.getHeader("Link");
    const linkValues: string[] = [];

    for (const rel in links) {
      const urls = Array.isArray(links[rel]) ? links[rel] : [links[rel]];

      for (const url of urls) {
        if (typeof url !== "string") continue;
        linkValues.push(`<${url}>; rel="${rel}"`);
      }
    }

    const newValue = linkValues.join(", ");

    if (existing) {
      this.setHeader("Link", `${existing}, ${newValue}`);
    } else {
      this.setHeader("Link", newValue);
    }

    return this;
  }

  /** Sets the encoded `Location` header. */
  location(location: string) {
    return this.set("Location", encodeUrl(location));
  }

  /**
   * Sets a cookie. Objects are stored as `j:` + JSON, like Express.
   *
   * @throws When `signed` is set but `cookie-parser` has no secret.
   */
  cookie(name: string, value: any, options: CookieOptions = {}) {
    let val =
      typeof value === "object" ? `j:${JSON.stringify(value)}` : String(value);

    if (options.signed) {
      const secret = this.req.secret;
      if (!secret)
        throw new Error('cookieParser("secret") required for signed cookies');
      val = `s:${signCookie(val, secret)}`;
    }

    const serialized = serializeCookie(name, val, options);
    this.append("Set-Cookie", serialized);
    return this;
  }

  /** Expires a cookie. Pass the same `path` and `domain` it was set with. */
  clearCookie(name: string, options: CookieOptions = {}) {
    const opts = { ...options, expires: new Date(1) };
    delete opts.maxAge;

    return this.cookie(name, "", opts);
  }

  /** Adds values to a header, keeping the existing ones. */
  append(field: string, value: string | string[]) {
    const prev = this.get(field);

    if (prev === undefined) return this.set(field, value);

    const previous = Array.isArray(prev) ? prev : [String(prev)];
    return this.set(field, previous.concat(value));
  }

  /** Adds fields to the `Vary` header without duplicates. */
  vary(headers: string) {
    if (!headers) return this;
    const existing = this.get("Vary") as string;

    if (existing === "*") return this;

    if (headers.trim() === "*") {
      this.set("Vary", "*");
      return this;
    }

    const uniqueHeaders = new Set<string>();

    if (existing) {
      existing
        .split(",")
        .map((header) => header.trim())
        .filter(Boolean)
        .forEach((header) => {
          uniqueHeaders.add(header.toLowerCase());
        });
    }

    headers
      .split(",")
      .map((header) => header.trim())
      .filter(Boolean)
      .forEach((header) => {
        uniqueHeaders.add(header.toLowerCase());
      });

    this.set("Vary", Array.from(uniqueHeaders).join(", "));

    return this;
  }

  /**
   * Runs the handler matching the `Accept` header and sets `Content-Type`
   * and `Vary: Accept`. Falls back to `default`, otherwise responds 406.
   *
   * @param formats - Handlers keyed by MIME type or extension.
   */
  format(formats: Record<string, () => any>) {
    const defaultHandler = formats.default;
    const normalized: Record<string, () => any> = {};

    for (const key in formats) {
      if (key === "default") continue;

      let mime = key;

      if (!key.includes("/")) {
        const ext = key.replace(/^\./, "");
        mime = MIME_TYPES[ext] || key;
      }

      normalized[mime] = formats[key];
    }

    const types = Object.keys(normalized);
    if (types.length > 0) this.vary("Accept");

    const match = types.length > 0 ? this.req.accepts(...types) : false;

    if (typeof match === "string") {
      this.type(match);
      return normalized[match]();
    }

    if (defaultHandler) {
      return defaultHandler();
    }

    return this.status(406).send("Not Acceptable");
  }

  /**
   * Marks the response as a download. With a file name, also sets
   * `Content-Type` from its extension.
   */
  attachment(filename?: string) {
    if (filename) this.type(extname(filename));
    return this.set("Content-Disposition", contentDisposition(filename && basename(filename)));
  }

  /**
   * Streams a file.
   *
   * Without `root` the path must be absolute. With `root`, paths containing
   * `..` are rejected. Supports single byte ranges and conditional GETs.
   * Without a callback, errors are answered with 404 for missing files and
   * the matching status otherwise. The file stream is closed when the client
   * disconnects, and the callback then receives the premature-close error.
   *
   * @param path - File path.
   * @param options - Transfer options, or the callback.
   * @param callback - Called when the transfer finishes or fails.
   * @throws When `path` is missing, or relative without `root`.
   */
  sendFile(
    path: string,
    options: SendFileOptions | SendFileCallback = {},
    callback?: SendFileCallback,
  ) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    if (!path) throw new TypeError("path argument is required to res.sendFile");

    if (!options.root && !isAbsolute(path)) {
      throw new TypeError(
        "path must be absolute or specify root to res.sendFile",
      );
    }

    const opts = options;
    const done = (error?: HttpError | NodeJS.ErrnoException) => {
      if (callback) return callback(error);
      if (!error) return;

      const status =
        error instanceof HttpError ? error.status : errorStatus(error);

      if (!this.headersSent) {
        this.removeHeader("Content-Disposition");
        this.sendStatus(status);
      } else if (!this.writableEnded) {
        this.destroy(error);
      }
    };

    const resolved = this.resolveFilePath(path, opts);
    if (resolved instanceof HttpError) return done(resolved);

    stat(resolved, (error, stats) => {
      if (error) return done(error);
      if (stats.isDirectory()) return done(new HttpError(404));

      this.setFileHeaders(resolved, stats, opts);

      if (this.req.fresh) {
        this.statusCode = 304;
        this.removeHeader("Content-Type");
        this.removeHeader("Content-Length");
        this.end();
        return done();
      }

      let start = 0;
      let end = Math.max(stats.size - 1, 0);

      if (opts.acceptRanges !== false && stats.size > 0) {
        const ranges = this.req.range(stats.size, { combine: true });

        if (ranges === -1) {
          this.set("Content-Range", `bytes */${stats.size}`);
          return done(new HttpError(416));
        }

        if (Array.isArray(ranges) && ranges.type === "bytes" && ranges.length === 1) {
          start = ranges[0].start;
          end = ranges[0].end;
          this.statusCode = 206;
          this.set("Content-Range", `bytes ${start}-${end}/${stats.size}`);
        }
      }

      const length = stats.size === 0 ? 0 : end - start + 1;
      this.set("Content-Length", String(length));

      if (this.req.method === "HEAD" || length === 0) {
        this.end();
        return done();
      }

      pipeline(createReadStream(resolved, { start, end }), this, (streamError) =>
        done(streamError ?? undefined),
      );
    });
  }

  /**
   * Sends a file as an attachment.
   *
   * @param path - File path, relative paths resolve against the working directory.
   * @param filename - Name shown to the user, defaults to the file's name.
   * @param options - Transfer options, see {@link SendFileOptions}.
   * @param callback - Called when the transfer finishes or fails.
   */
  download(
    path: string,
    filename?: string | SendFileOptions | SendFileCallback,
    options?: SendFileOptions | SendFileCallback,
    callback?: SendFileCallback,
  ) {
    let name: string | undefined;
    let opts: SendFileOptions = {};

    for (const arg of [filename, options, callback]) {
      if (typeof arg === "string") name = arg;
      else if (typeof arg === "function") callback = arg;
      else if (arg) opts = arg;
    }

    const fullPath = opts.root ? path : resolve(path);

    return this.sendFile(
      fullPath,
      {
        ...opts,
        headers: {
          ...opts.headers,
          "Content-Disposition": contentDisposition(name || basename(path)),
        },
      },
      callback,
    );
  }

  /**
   * Resolves and checks a path for {@link Response.sendFile}.
   *
   * @returns The absolute path, or an {@link HttpError} for null bytes (400),
   * traversal (403) and dotfiles (per `options.dotfiles`).
   */
  private resolveFilePath(path: string, options: SendFileOptions) {
    if (path.includes("\0")) return new HttpError(400);

    const segments = path.split(/[\\/]+/);

    if (options.root && segments.includes("..")) return new HttpError(403);

    const resolved = options.root
      ? join(resolve(options.root), path)
      : resolve(path);

    if (options.root) {
      const root = resolve(options.root);
      if (resolved !== root && !resolved.startsWith(root + sep))
        return new HttpError(403);
    }

    const checked = options.root ? segments : resolved.split(sep);
    const hasDotfile = checked.some(
      (segment) => segment.length > 1 && segment.startsWith("."),
    );

    if (hasDotfile) {
      const policy = options.dotfiles || "ignore";
      if (policy === "deny") return new HttpError(403);
      if (policy === "ignore") return new HttpError(404);
    }

    return resolved;
  }

  /** Sets caching and type headers for a file transfer. */
  private setFileHeaders(
    path: string,
    stats: { size: number; mtime: Date },
    options: SendFileOptions,
  ) {
    if (options.acceptRanges !== false) this.set("Accept-Ranges", "bytes");

    if (options.cacheControl !== false && !this.get("Cache-Control")) {
      let cacheControl = `public, max-age=${Math.floor((options.maxAge || 0) / 1000)}`;
      if (options.immutable) cacheControl += ", immutable";
      this.set("Cache-Control", cacheControl);
    }

    if (options.lastModified !== false && !this.get("Last-Modified")) {
      this.set("Last-Modified", stats.mtime.toUTCString());
    }

    if (options.etag !== false && !this.get("ETag")) {
      this.set(
        "ETag",
        `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`,
      );
    }

    if (!this.get("Content-Type")) {
      const mime = MIME_TYPES[extname(path).slice(1).toLowerCase()];
      this.set("Content-Type", mime || "application/octet-stream");
    }

    if (options.headers) this.set(options.headers);
  }
}

/** HTTP status for a file system error: 404 for missing files, 500 otherwise. */
function errorStatus(error: NodeJS.ErrnoException): number {
  return error.code === "ENOENT" ||
    error.code === "ENAMETOOLONG" ||
    error.code === "ENOTDIR"
    ? 404
    : 500;
}
