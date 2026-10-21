import { ServerResponse, STATUS_CODES } from "http";
import { close, createReadStream, fstat, open, realpath, stat, Stats } from "fs";
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
  isPreconditionFailure,
  isRangeFresh,
  lookupMime,
  parseTokenList,
  setCharset,
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
  /**
   * Follow symlinks that point outside `root`. Default `true`, like Express.
   * With `false` the real path must stay inside the real `root`, otherwise 403.
   * Only applies with `root`.
   */
  followSymlinks?: boolean;
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
  /**
   * Files tried, in order, when the path ends with `/`, like Express's
   * `send`. Default `"index.html"`; `false` turns it off.
   */
  index?: string | string[] | false;
}

/** Called when a file transfer finishes or fails. */
type SendFileCallback = (error?: Error) => void;

/** Error carrying an HTTP status, like `http-errors`, used for file transfers and `res.format()`. */
class HttpError extends Error {
  statusCode: number;
  expose: boolean;
  [key: string]: unknown;

  /**
   * @param status - HTTP status code.
   * @param message - Defaults to the status code's standard message.
   */
  constructor(
    public status: number,
    message = STATUS_CODES[status] || String(status),
  ) {
    super(message);
    this.statusCode = status;
    this.expose = status < 500;
  }
}

/** Replacements of the `"json escape"` setting. */
const JSON_ESCAPES: Record<string, string> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };

/** A `Vary` field name (RFC 7230 token). */
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
      const type = this.get("Content-Type");
      if (typeof type === "string") this.setHeader("Content-Type", setCharset(type, "utf-8"));
      else this.type("html");
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

      // The app's "etag fn"; a response of no app gets weak ETags.
      const etagFn = this.app ? this.app.settings["etag fn"] : generateETag;
      if (typeof etagFn === "function" && !this.hasHeader("ETag")) {
        const etag = etagFn(chunk);
        if (etag) this.setHeader("ETag", etag);
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
   * Sends any JSON value, using the app's `"json replacer"`, `"json spaces"`
   * and `"json escape"` settings.
   */
  json(data: any): this {
    if (!this.hasHeader("Content-Type"))
      this.setHeader("Content-Type", "application/json; charset=utf-8");

    const body = this.stringify(data);
    return this.send(body === undefined ? "" : body);
  }

  /**
   * Sends JSON, or JSONP when the query has a callback, like Express:
   * `?callback=fn` (the `"jsonp callback name"` setting) answers
   * `/**\/ typeof fn === 'function' && fn(<json>);` as `text/javascript`.
   * The callback name keeps only letters, digits, `_`, `$`, `.`, `[` and
   * `]`, and the leading comment defeats "Rosetta Flash" attacks.
   */
  jsonp(data: any): this {
    let body = this.stringify(data);
    let callback = this.req.query?.[this.app?.settings["jsonp callback name"] ?? "callback"];

    if (!this.get("Content-Type")) {
      this.set("X-Content-Type-Options", "nosniff");
      this.set("Content-Type", "application/json");
    }

    if (Array.isArray(callback)) callback = callback[0];

    if (typeof callback === "string" && callback.length !== 0) {
      this.set("X-Content-Type-Options", "nosniff");
      this.set("Content-Type", "text/javascript");

      const name = callback.replace(/[^[\]\w$.]/g, "");
      // U+2028 and U+2029 are valid in JSON but end a line in older JavaScript.
      const json = body === undefined ? "" : body.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      body = `/**/ typeof ${name} === 'function' && ${name}(${json});`;
    }

    return this.send(body);
  }

  /**
   * `JSON.stringify` with the app's JSON settings. With `"json escape"`,
   * `<`, `>` and `&` become `\u003c`, `\u003e` and `\u0026`, so the JSON
   * can't close a `<script>` tag it is embedded in, like Express 5.
   */
  private stringify(data: any): string | undefined {
    const settings = this.app?.settings;
    const json = JSON.stringify(data, settings?.["json replacer"], settings?.["json spaces"]);
    if (!settings?.["json escape"] || json === undefined) return json;
    return json.replace(/[<>&]/g, (char) => JSON_ESCAPES[char]);
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
   * Sets `Content-Type` from a MIME type or an extension such as `"json"`,
   * adding a charset where Express does. Unknown extensions become
   * `application/octet-stream`.
   */
  type(value: string) {
    if (typeof value !== "string") return this;
    if (value.includes("/")) return this.set("Content-Type", value);

    const mime = lookupMime(value);
    return this.set("Content-Type", mime ? contentType(mime) : "application/octet-stream");
  }

  /** Same as {@link Response.type}, like Express's `res.contentType()`. */
  contentType(value: string) {
    return this.type(value);
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
        body = `<!DOCTYPE html><head><title>${statusText}</title></head><body><p>${statusText}. Redirecting to ${escaped}</p></body>`;
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

  /**
   * Adds fields to the `Vary` header like the `vary` package: duplicates are
   * compared case-insensitively, the first spelling is kept, and `*` replaces
   * everything.
   *
   * @throws When a field isn't a valid header name.
   */
  vary(field: string | string[]) {
    if (!field || (Array.isArray(field) && field.length === 0)) return this;

    const fields = Array.isArray(field) ? field : parseTokenList(String(field));
    for (const name of fields) {
      if (!FIELD_NAME.test(name)) {
        throw new TypeError("field argument contains an invalid header name");
      }
    }

    const existing = this.getHeader("Vary");
    let header = Array.isArray(existing) ? existing.join(", ") : String(existing ?? "");
    if (header === "*") return this;

    const seen = parseTokenList(header.toLowerCase());
    if (fields.includes("*") || seen.includes("*")) {
      this.setHeader("Vary", "*");
      return this;
    }

    for (const name of fields) {
      const lower = name.toLowerCase();
      if (seen.includes(lower)) continue;
      seen.push(lower);
      header = header ? `${header}, ${name}` : name;
    }

    this.setHeader("Vary", header);
    return this;
  }

  /**
   * Runs the handler matching the `Accept` header, like Express: sets
   * `Vary: Accept` and the matched `Content-Type`, then calls the handler with
   * `(req, res, next)`. Falls back to `default`, otherwise passes a 406 error
   * with the offered `types` to `next()`.
   *
   * @param formats - Handlers keyed by MIME type or extension.
   */
  format(formats: Record<string, (req?: Request, res?: Response, next?: (err?: any) => void) => any>) {
    const req = this.req;
    const next = req.next;
    const keys = Object.keys(formats).filter((key) => key !== "default");
    const key = keys.length > 0 ? (req.accepts(keys) as string | false) : false;

    this.vary("Accept");

    if (key) {
      this.set("Content-Type", mimeOfFormat(key));
      return formats[key](req, this, next);
    }

    if (formats.default) return formats.default(req, this, next);

    const error = new HttpError(406);
    error.types = keys.map(mimeOfFormat);
    if (next) return next(error);
    return this.sendStatus(406);
  }

  /**
   * Renders a view with the app's template engine and sends it, like
   * Express: `res.locals` are available to the view, and errors go to
   * `next(err)`. With a callback, it gets the error or HTML instead and
   * nothing is sent.
   *
   * @param view - View name, see {@link Pype.render}.
   * @param options - Values for the template, or the callback.
   * @param callback - Called with an error, or the HTML.
   */
  render(
    view: string,
    options: Record<string, any> | ((err: Error | null, html?: string) => void) = {},
    callback?: (err: Error | null, html?: string) => void,
  ) {
    let done = callback;
    let opts = options as Record<string, any>;
    if (typeof options === "function") {
      done = options as (err: Error | null, html?: string) => void;
      opts = {};
    }

    const req = this.req;
    done ??= (err, html) => {
      if (err) return req.next ? req.next(err) : this.status(500).end();
      this.send(html);
    };

    this.app.render(view, { ...opts, _locals: this.locals }, done);
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
   * `..` are rejected, and with `followSymlinks: false` so are symlinks that
   * lead outside it. Supports single byte ranges and conditional GETs.
   * Without a callback, errors go to `next(err)` like Express, as an
   * {@link HttpError} with the status (404 for missing files) and the file
   * system `code`; a directory calls `next()` so later routes can answer.
   * The file stream is closed when the client disconnects, and the callback
   * then receives the premature-close error.
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

      // The client went away, there is nobody to answer.
      if (ABORT_CODES.has(error.code as string)) {
        if (!this.writableEnded) this.destroy();
        return;
      }

      const next = this.req.next;
      if (error.code === "EISDIR" && next) return next();

      // A fresh HttpError keeps file system paths out of the error message.
      const httpError =
        error instanceof HttpError ? error : new HttpError(errorStatus(error));
      if (!(error instanceof HttpError)) {
        httpError.code = error.code;
        httpError.cause = error;
      }

      if (!this.headersSent) this.removeHeader("Content-Disposition");
      if (next) return next(httpError);

      if (!this.headersSent) this.sendStatus(httpError.status);
      else if (!this.writableEnded) this.destroy(error);
    };

    const resolved = this.resolveFilePath(path, opts);
    if (resolved instanceof HttpError) return done(resolved);

    const send = (file: string) => this.transferFile(file, opts, done);

    // Like Express's send, a trailing slash asks for a directory: its index
    // file is sent, and a plain file is never matched (Windows would ignore
    // the slash).
    if (path.endsWith("/")) {
      const index = opts.index === false ? [] : [opts.index ?? "index.html"].flat();
      if (index.length > 0) return sendIndex(resolved, index, send, done);
      return stat(resolved, (error, stats) => {
        if (error) return done(error);
        done(stats.isDirectory() ? Object.assign(new HttpError(404, "EISDIR, read"), { code: "EISDIR" }) : new HttpError(404));
      });
    }

    send(resolved);
  }

  /**
   * Streams a checked file path, see {@link Response.sendFile}. The file is
   * opened first and everything after reads that descriptor, so a path
   * swapped for a symlink after the checks is never what gets served.
   */
  private transferFile(
    resolved: string,
    opts: SendFileOptions,
    done: (error?: HttpError | NodeJS.ErrnoException) => void,
  ) {
    open(resolved, "r", (openError, fd) => {
      // Windows can't open a directory.
      if (openError) return done(openError.code === "EISDIR" ? directoryError() : openError);

      const finish = (error?: HttpError | NodeJS.ErrnoException) => close(fd, () => done(error));

      fstat(fd, (statError, stats) => {
        if (statError) return finish(statError);
        if (opts.root && opts.followSymlinks === false) {
          return checkRealPath(resolved, opts.root, stats, (error) =>
            error ? finish(error) : this.transferOpenFile(resolved, fd, stats, opts, done, finish),
          );
        }
        this.transferOpenFile(resolved, fd, stats, opts, done, finish);
      });
    });
  }

  /** The rest of {@link Response.transferFile}, once `fd` is known to be the file to send. */
  private transferOpenFile(
    resolved: string,
    fd: number,
    stats: Stats,
    opts: SendFileOptions,
    done: (error?: HttpError | NodeJS.ErrnoException) => void,
    finish: (error?: HttpError | NodeJS.ErrnoException) => void,
  ) {
    if (stats.isDirectory()) return finish(directoryError());

    this.setFileHeaders(resolved, stats, opts);

    if (isPreconditionFailure(this.req.headers, this.getHeaders())) {
      return finish(new HttpError(412));
    }

    if (this.req.fresh) {
      this.statusCode = 304;
      this.removeHeader("Content-Type");
      this.removeHeader("Content-Length");
      this.end();
      return finish();
    }

    let start = 0;
    let end = Math.max(stats.size - 1, 0);

    // An outdated If-Range asks for the whole file, not a part of a newer one.
    if (opts.acceptRanges !== false && isRangeFresh(this.req.headers, this.getHeaders())) {
      const ranges = this.req.range(stats.size, { combine: true });

      if (ranges === -1) {
        // On the error too, like Express's send: error handlers reset the headers.
        const headers = { "Content-Range": `bytes */${stats.size}` };
        this.set(headers);
        return finish(Object.assign(new HttpError(416), { headers }));
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
      return finish();
    }

    // The stream owns the descriptor from here and closes it.
    pipeline(createReadStream(resolved, { fd, start, end }), this, (streamError) =>
      done(streamError ?? undefined),
    );
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
          "Content-Disposition": contentDisposition(basename(name || path)),
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

/**
 * Sends the first of `names` in `dir` that is a file, like `send`'s index
 * support; 404 (or the last file system error) when there is none.
 */
function sendIndex(
  dir: string,
  names: string[],
  send: (file: string) => void,
  done: (error?: HttpError | NodeJS.ErrnoException) => void,
) {
  let i = 0;
  const next = (error?: NodeJS.ErrnoException) => {
    if (i >= names.length) return done(error ?? new HttpError(404));
    const file = join(dir, names[i++]);
    stat(file, (statError, stats) => {
      if (statError) return next(statError);
      if (stats.isDirectory()) return next();
      send(file);
    });
  };
  next();
}

/** Error codes of a transfer the client aborted, ignored like Express does. */
const ABORT_CODES = new Set(["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "ECONNABORTED", "EPIPE"]);

/** The MIME type of a `res.format()` key, without parameters. */
function mimeOfFormat(key: string): string {
  if (key.includes("/")) return key.split(";")[0].trim();
  return lookupMime(key) || "application/octet-stream";
}

/** HTTP status for a file system error: 404 for missing files, 500 otherwise. */
function errorStatus(error: NodeJS.ErrnoException): number {
  return error.code === "ENOENT" ||
    error.code === "ENAMETOOLONG" ||
    error.code === "ENOTDIR"
    ? 404
    : 500;
}

/**
 * Checks that the real path of `file`, with symlinks resolved, stays inside
 * the real path of `root`. Calls back with a 403 when it leads outside, or
 * the file system error (e.g. ENOENT for a missing file).
 */
function checkRealPath(
  file: string,
  root: string,
  opened: Stats,
  callback: (error?: HttpError | NodeJS.ErrnoException) => void,
) {
  realpath(root, (rootError, realRoot) => {
    if (rootError) return callback(rootError);

    realpath(file, (fileError, realFile) => {
      if (fileError) return callback(fileError);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + sep))
        return callback(new HttpError(403));

      // The path may have changed since it was opened: the file checked
      // inside the root must be the one that was opened.
      stat(realFile, (statError, checked) => {
        if (statError) return callback(statError);
        if (checked.dev !== opened.dev || checked.ino !== opened.ino) return callback(new HttpError(403));
        callback();
      });
    });
  });
}

/** The error for a directory where a file was expected, which `sendFile` turns into `next()`. */
function directoryError() {
  return Object.assign(new HttpError(404, "EISDIR, read"), { code: "EISDIR" });
}
