import { IncomingMessage } from "http";
import { isIP } from "net";
import { TLSSocket } from "tls";
import type { Response } from "./response";
import type { Pype } from "./server";
import {
  Ranges,
  acceptedValues,
  isFresh,
  matchContentType,
  matchLanguage,
  matchMediaType,
  matchToken,
  negotiate,
  normalizeType,
  parseRange,
} from "../utils/helpers";
import { TrustFunction, trustedAddresses } from "../utils/trust-proxy";

// Lets type augmentations written for Express (passport's req.user,
// multer's req.file, ...) apply to Pype's request and response too.
declare global {
  namespace Express {
    interface Request {}
    interface Response {}
  }
}

export interface Request extends Express.Request {}

export interface RouteInfo {
  path: string;
  method: string;
}

export class Request extends IncomingMessage {
  app!: Pype;
  res!: Response;
  path = "/";
  originalUrl = "/";
  baseUrl = "";
  route?: RouteInfo;
  params: Record<string, string> = {};
  query: Record<string, string | string[]> = {};
  body?: any;
  next?: (err?: any) => void;

  // Set by cookie-parser. Left undefined otherwise, like Express, because
  // cookie-parser skips requests that already have req.cookies.
  cookies?: Record<string, any>;
  signedCookies?: Record<string, any>;
  secret?: string;
  // Set by body parsers once the body has been read.
  _body?: boolean;

  get(header: string): string | string[] | undefined {
    const name = header.toLowerCase();

    if (name === "referer" || name === "referrer") {
      return this.headers.referer ?? this.headers.referrer;
    }

    return this.headers[name];
  }

  header(header: string): string | string[] | undefined {
    return this.get(header);
  }

  accepts(...types: (string | string[])[]): string | string[] | false {
    const offers = types.flat();
    const header = this.get("Accept") as string | undefined;

    if (offers.length === 0) return acceptedValues(header || "*/*");
    if (!header) return offers[0];

    const ranked = negotiate(
      header,
      offers.map(normalizeType),
      matchMediaType,
    );
    if (ranked.length === 0) return false;

    return offers[offers.map(normalizeType).indexOf(ranked[0])];
  }

  acceptsCharsets(...charsets: (string | string[])[]): string | string[] | false {
    return this.negotiateHeader("Accept-Charset", charsets.flat(), matchToken);
  }

  acceptsEncodings(
    ...encodings: (string | string[])[]
  ): string | string[] | false {
    return this.negotiateHeader(
      "Accept-Encoding",
      encodings.flat(),
      matchToken,
      (offer) => (offer === "identity" ? 1 : undefined),
      "identity",
    );
  }

  acceptsLanguages(...languages: (string | string[])[]): string | string[] | false {
    return this.negotiateHeader(
      "Accept-Language",
      languages.flat(),
      matchLanguage,
    );
  }

  is(...types: (string | string[])[]): string | false | null {
    if (!this.hasBody()) return null;

    const header = this.headers["content-type"];
    if (!header) return false;

    const actual = header.split(";")[0].trim().toLowerCase();
    const patterns = types.flat();

    if (patterns.length === 0) return actual;

    for (const pattern of patterns) {
      if (matchContentType(actual, pattern)) return pattern;
    }

    return false;
  }

  range(size: number, options?: { combine?: boolean }): Ranges | -1 | -2 | undefined {
    const header = this.get("Range") as string | undefined;
    if (!header) return undefined;
    return parseRange(size, header, options);
  }

  get protocol(): string {
    const encrypted = (this.socket as TLSSocket)?.encrypted;
    const protocol = encrypted ? "https" : "http";

    if (!this.trustsSocket) return protocol;

    const forwarded = this.get("X-Forwarded-Proto") as string | undefined;
    return forwarded ? forwarded.split(",")[0].trim() : protocol;
  }

  get secure(): boolean {
    return this.protocol === "https";
  }

  get ip(): string | undefined {
    const addresses = trustedAddresses(this, this.trust);
    return addresses[addresses.length - 1] || undefined;
  }

  // Client address first, then the proxies, excluding the socket address.
  get ips(): string[] {
    const addresses = trustedAddresses(this, this.trust);
    return addresses.slice(1).reverse();
  }

  get host(): string | undefined {
    let host = this.trustsSocket
      ? (this.get("X-Forwarded-Host") as string | undefined)
      : undefined;

    if (host) host = host.split(",")[0].trim();
    else host = this.get("Host") as string | undefined;

    return host || undefined;
  }

  get hostname(): string | undefined {
    const host = this.host;
    if (!host) return undefined;

    // IPv6 literals are wrapped in brackets: [::1]:3000
    const offset = host.startsWith("[") ? host.indexOf("]") + 1 : 0;
    const colon = host.indexOf(":", offset);

    return colon !== -1 ? host.substring(0, colon) : host;
  }

  get subdomains(): string[] {
    const hostname = this.hostname;
    if (!hostname) return [];

    if (isIP(hostname.replace(/^\[|\]$/g, ""))) return [];

    const offset = this.app?.settings["subdomain offset"] ?? 2;
    return hostname.split(".").reverse().slice(offset);
  }

  get xhr(): boolean {
    const header = this.get("X-Requested-With") as string | undefined;
    return header?.toLowerCase() === "xmlhttprequest";
  }

  get fresh(): boolean {
    const method = this.method;
    const status = this.res.statusCode;

    if (method !== "GET" && method !== "HEAD") return false;

    // most requests are unconditional, skip copying the response headers
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

  get stale(): boolean {
    return !this.fresh;
  }

  private get trust(): TrustFunction {
    return this.app?.settings["trust proxy fn"] ?? (() => false);
  }

  // Whether the immediate peer is a trusted proxy whose X-Forwarded-* headers
  // can be used.
  private get trustsSocket(): boolean {
    return this.trust(this.socket?.remoteAddress || "", 0);
  }

  private hasBody(): boolean {
    return (
      this.headers["transfer-encoding"] !== undefined ||
      (this.headers["content-length"] !== undefined &&
        this.headers["content-length"] !== "0")
    );
  }

  private negotiateHeader(
    name: string,
    offers: string[],
    match: (pattern: string, offer: string) => number,
    defaultQ?: (offer: string) => number | undefined,
    fallback = "*",
  ): string | string[] | false {
    const header = this.get(name) as string | undefined;

    if (offers.length === 0) {
      return header ? acceptedValues(header) : [fallback];
    }

    if (header === undefined) return offers[0];

    const ranked = negotiate(header, offers, match, defaultQ);
    return ranked.length > 0 ? ranked[0] : false;
  }
}
