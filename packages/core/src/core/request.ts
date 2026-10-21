import { IncomingMessage } from "http";
import { isIP } from "net";
import { TLSSocket } from "tls";
import type { Response } from "./response";
import type { Pype } from "./server";
import {
  Ranges,
  isFresh,
  lookupMime,
  matchContentType,
  mediaTypeOf,
  parseRange,
  preferredCharsets,
  preferredEncodings,
  preferredLanguages,
  preferredMediaTypes,
} from "../utils/helpers";
import { TrustFunction, trustedAddresses } from "../utils/trust-proxy";

/**
 * Lets type augmentations written for Express (passport's `req.user`,
 * multer's `req.file`, ...) apply to Pype's request and response too.
 */
declare global {
  namespace Express {
    /** Augmented by packages such as passport and multer. */
    interface Request {}
    /** Augmented by packages that add response helpers. */
    interface Response {}
  }
}

/** Merges Express request augmentations into {@link Request}. */
export interface Request extends Express.Request {}

/** The route that matched a request, exposed as `req.route`. */
export interface RouteInfo {
  /** Route path as written in its definition, e.g. `/users/:id`, a RegExp, or an array of them. */
  path: string | RegExp | Array<string | RegExp>;
  /** Lower-case HTTP method of the request. */
  method: string;
}

/** Express-compatible request, extends Node's `IncomingMessage`. */
export class Request extends IncomingMessage {
  /** The app handling the request. */
  app!: Pype;
  /** The response for this request. */
  res!: Response;
  /** Request path without the query string, relative to the current mount path. */
  path = "/";
  /** The full original request URL, including the query string. */
  originalUrl = "/";
  /** Path the current router or middleware is mounted on. */
  baseUrl = "";
  /** The matched route, set while its handlers run. */
  route?: RouteInfo;
  /** Decoded route params, `"*"` holds the wildcard capture. */
  params: Record<string, string> = {};
  /** Parsed query string, repeated keys become arrays. */
  query: Record<string, string | string[]> = {};
  /** Parsed body, set by a body-parsing middleware. */
  body?: any;
  /** The pipeline's `next` function. */
  next?: (err?: any) => void;

  /**
   * Cookies, set by `cookie-parser`. Left undefined otherwise, like Express,
   * because `cookie-parser` skips requests that already have `req.cookies`.
   */
  cookies?: Record<string, any>;
  /** Signed cookies that passed verification, set by `cookie-parser`. */
  signedCookies?: Record<string, any>;
  /** Cookie secret, set by `cookie-parser` and used by `res.cookie(..., { signed: true })`. */
  secret?: string;
  /** Set by body parsers once the body has been read. */
  _body?: boolean;

  /**
   * Reads a request header, case-insensitively. `Referer` and `Referrer` are
   * interchangeable.
   */
  get(header: string): string | string[] | undefined {
    // Express's errors, for code written against them.
    if (!header) throw new TypeError("name argument is required to req.get");
    if (typeof header !== "string") throw new TypeError("name must be a string to req.get");
    const name = header.toLowerCase();

    if (name === "referer" || name === "referrer") {
      return this.headers.referer ?? this.headers.referrer;
    }

    return this.headers[name];
  }

  /** Alias of {@link Request.get}. */
  header(header: string): string | string[] | undefined {
    return this.get(header);
  }

  /**
   * Picks the best of `types` for the `Accept` header, honouring q-values.
   *
   * @param types - Extensions like `"json"` or MIME types like `"text/html"`.
   * @returns The best type as given, `false` when none is acceptable, or the
   * accepted types (most preferred first) when called without arguments.
   */
  accepts(...types: (string | string[])[]): string | string[] | false {
    const offers = types.flat();
    const header = this.headers.accept;

    if (offers.length === 0) return preferredMediaTypes(header);
    if (!header) return offers[0];

    const mimes = offers.map((offer) => (offer.includes("/") ? offer : lookupMime(offer)));
    const best = preferredMediaTypes(header, mimes.filter((mime) => mime !== false))[0];
    return best ? offers[mimes.indexOf(best)] : false;
  }

  /**
   * Picks the best charset for the `Accept-Charset` header.
   *
   * @returns The best charset, `false` when none is acceptable, or the
   * accepted charsets when called without arguments.
   */
  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false {
    return pick(preferredCharsets, this.headers["accept-charset"] as string | undefined, charsets.flat());
  }

  /**
   * Picks the best encoding for the `Accept-Encoding` header. `identity` is
   * acceptable unless the client explicitly refuses it.
   *
   * @returns The best encoding, `false` when none is acceptable, or the
   * accepted encodings when called without arguments.
   */
  acceptsEncodings(
    ...encodings: (string | string[])[]
  ): string | string[] | false {
    return pick(preferredEncodings, this.headers["accept-encoding"] as string | undefined, encodings.flat());
  }

  /**
   * Picks the best language for the `Accept-Language` header. An `en`
   * preference matches an `en-US` offer and the other way around, `en-GB`
   * doesn't match `en-US`.
   *
   * @returns The best language, `false` when none is acceptable, or the
   * accepted languages when called without arguments.
   */
  acceptsLanguages(...languages: (string | string[])[]): string | string[] | false {
    return pick(preferredLanguages, this.headers["accept-language"] as string | undefined, languages.flat());
  }

  /**
   * Checks the request's `Content-Type`.
   *
   * @param types - Patterns like `"json"`, `"text/*"`, `"+json"`,
   * `"urlencoded"` or `"multipart"`.
   * @returns Like `type-is`: the matching pattern, or the actual type for
   * patterns with `*` or a leading `+`; `false` when none matches or the
   * `Content-Type` is missing or invalid; `null` when the request has no body.
   */
  is(...types: (string | string[])[]): string | false | null {
    if (!this.hasBody()) return null;

    const actual = mediaTypeOf(this.headers["content-type"]);
    if (!actual) return false;

    const patterns = types.flat();
    if (patterns.length === 0) return actual;

    for (const pattern of patterns) {
      if (matchContentType(actual, pattern)) {
        return pattern.startsWith("+") || pattern.includes("*") ? actual : pattern;
      }
    }

    return false;
  }

  /**
   * Parses the `Range` header.
   *
   * @param size - Size of the resource in bytes.
   * @param options - `combine` merges overlapping and adjacent ranges.
   * @returns The ranges, `-1` when unsatisfiable, `-2` when malformed, or
   * `undefined` without a `Range` header.
   */
  range(size: number, options?: { combine?: boolean }): Ranges | -1 | -2 | undefined {
    const header = this.get("Range") as string | undefined;
    if (!header) return undefined;
    return parseRange(size, header, options);
  }

  /** `"http"` or `"https"`, from `X-Forwarded-Proto` when the proxy is trusted. */
  get protocol(): string {
    const encrypted = (this.socket as TLSSocket)?.encrypted;
    const protocol = encrypted ? "https" : "http";

    if (!this.trustsSocket) return protocol;

    const forwarded = this.get("X-Forwarded-Proto") as string | undefined;
    return forwarded ? forwarded.split(",")[0].trim() : protocol;
  }

  /** Whether the request was made over HTTPS. */
  get secure(): boolean {
    return this.protocol === "https";
  }

  /** Client address, from `X-Forwarded-For` as far as proxies are trusted. */
  get ip(): string | undefined {
    const addresses = trustedAddresses(this, this.trust);
    return addresses[addresses.length - 1] || undefined;
  }

  /** Trusted `X-Forwarded-For` addresses: client first, then the proxies, excluding the socket address. */
  get ips(): string[] {
    const addresses = trustedAddresses(this, this.trust);
    return addresses.slice(1).reverse();
  }

  /** `Host` header including the port, `X-Forwarded-Host` when the proxy is trusted. */
  get host(): string | undefined {
    let host = this.trustsSocket
      ? (this.get("X-Forwarded-Host") as string | undefined)
      : undefined;

    if (host) host = host.split(",")[0].trim();
    else host = this.get("Host") as string | undefined;

    return host || undefined;
  }

  /** Host without the port. IPv6 literals keep their brackets, e.g. `[::1]`. */
  get hostname(): string | undefined {
    const host = this.host;
    if (!host) return undefined;

    const offset = host.startsWith("[") ? host.indexOf("]") + 1 : 0;
    const colon = host.indexOf(":", offset);

    return colon !== -1 ? host.substring(0, colon) : host;
  }

  /**
   * Subdomains in reverse order, e.g. `["shop", "api"]` for
   * `api.shop.example.com`. The last `"subdomain offset"` parts are dropped.
   */
  get subdomains(): string[] {
    const hostname = this.hostname;
    if (!hostname) return [];

    // Like Express: an IPv4 address is one part, so it only counts with a
    // "subdomain offset" of 0.
    const offset = this.app?.settings["subdomain offset"] ?? 2;
    const parts = isIP(hostname) ? [hostname] : hostname.split(".").reverse();
    return parts.slice(offset);
  }

  /** Whether `X-Requested-With` is `XMLHttpRequest`. */
  get xhr(): boolean {
    const header = this.get("X-Requested-With") as string | undefined;
    return header?.toLowerCase() === "xmlhttprequest";
  }

  /**
   * Whether the client's cached copy is still valid, based on `ETag` and
   * `Last-Modified`. Unconditional requests skip reading the response headers.
   */
  get fresh(): boolean {
    const method = this.method;
    const status = this.res.statusCode;

    // Like Express, QUERY is safe and cacheable too.
    if (method !== "GET" && method !== "HEAD" && method !== "QUERY") return false;

    if (
      this.headers["if-none-match"] === undefined &&
      this.headers["if-modified-since"] === undefined
    ) {
      return false;
    }

    if ((status >= 200 && status < 300) || status === 304) {
      return isFresh(this.headers, this.res.getHeaders());
    }

    return false;
  }

  /** Opposite of {@link Request.fresh}. */
  get stale(): boolean {
    return !this.fresh;
  }

  /** The app's compiled `trust proxy` setting. */
  private get trust(): TrustFunction {
    return this.app?.settings["trust proxy fn"] ?? (() => false);
  }

  /** Whether the immediate peer is a trusted proxy whose `X-Forwarded-*` headers can be used. */
  private get trustsSocket(): boolean {
    return this.trust(this.socket?.remoteAddress || "", 0);
  }

  /**
   * Whether the request has a body, like `type-is`: a `Transfer-Encoding`,
   * or any numeric `Content-Length`, including 0.
   */
  private hasBody(): boolean {
    return (
      this.headers["transfer-encoding"] !== undefined ||
      !Number.isNaN(Number(this.headers["content-length"] ?? NaN))
    );
  }
}

/**
 * Shared logic of `acceptsCharsets`, `acceptsEncodings` and
 * `acceptsLanguages`, like the `accepts` package.
 *
 * @returns The accepted values without offers, otherwise the best offer or
 * `false`.
 */
function pick(
  preferred: (header: string | undefined, offers?: string[]) => string[],
  header: string | undefined,
  offers: string[],
): string[] | string | false {
  if (offers.length === 0) return preferred(header);
  return preferred(header, offers)[0] || false;
}
