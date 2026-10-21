import { createHash, createHmac } from "crypto";
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "http";
import { CookieOptions } from "../types/cookie-options";
import { parse } from "querystring";
import { MIME_TYPES } from "../enums/mime-types";

/** RFC 6265 cookie name: an HTTP token. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** RFC 6265 cookie value, after encoding. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/** Attribute values such as Domain and Path: printable, without `;`. */
const COOKIE_ATTRIBUTE = /^[\x20-\x3a\x3c-\x7e]*$/;

/** Allowed `Priority` values, like the `cookie` package. */
const PRIORITIES = new Map([["low", "Low"], ["medium", "Medium"], ["high", "High"]]);

/** Allowed `SameSite` values, like the `cookie` package. */
const SAME_SITE = new Map([["lax", "Lax"], ["strict", "Strict"], ["none", "None"]]);

/**
 * Builds a `Set-Cookie` header value.
 *
 * @param name - Cookie name.
 * @param value - Cookie value, encoded with `options.encode`.
 * @param options - Cookie attributes.
 * @throws TypeError with the `cookie` package's messages when the name,
 * encoded value, domain or path contains
 * characters that would break or inject into the header, or `priority` or
 * `sameSite` isn't one of the allowed values.
 */
function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
) {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError("argument name is invalid");
  }

  const encode = options.encode || encodeURIComponent;
  const encoded = encode(value);

  if (!COOKIE_VALUE.test(encoded)) {
    throw new TypeError("argument val is invalid");
  }

  for (const attribute of ["domain", "path"] as const) {
    const attributeValue = options[attribute];
    if (attributeValue !== undefined && !COOKIE_ATTRIBUTE.test(attributeValue)) {
      throw new TypeError(`option ${attribute} is invalid`);
    }
  }

  if (options.maxAge != null && !Number.isFinite(options.maxAge)) {
    throw new TypeError("option maxAge is invalid");
  }

  if (options.expires && Number.isNaN(options.expires.getTime())) {
    throw new TypeError("option expires is invalid");
  }

  let cookie = `${name}=${encoded}`;

  if (options.maxAge != null) {
    const maxAge = Math.floor(options.maxAge / 1000);
    cookie += `; Max-Age=${maxAge}`;
    cookie += `; Expires=${new Date(Date.now() + options.maxAge).toUTCString()}`;
  }

  if (options.domain) cookie += `; Domain=${options.domain}`;

  if (options.path) cookie += `; Path=${options.path}`;
  else cookie += `; Path=/`;

  if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;

  if (options.httpOnly) cookie += `; HttpOnly`;

  if (options.secure) cookie += `; Secure`;

  if (options.partitioned) cookie += `; Partitioned`;

  if (options.priority) {
    const priority = PRIORITIES.get(String(options.priority).toLowerCase());
    if (!priority) throw new TypeError("option priority is invalid");
    cookie += `; Priority=${priority}`;
  }

  if (options.sameSite) {
    const sameSite =
      options.sameSite === true
        ? "Strict"
        : SAME_SITE.get(String(options.sameSite).toLowerCase());
    if (!sameSite) throw new TypeError("option sameSite is invalid");
    cookie += `; SameSite=${sameSite}`;
  }

  return cookie;
}

/**
 * Signs a cookie value in the format of the `cookie-signature` package used
 * by Express and `cookie-parser`: `<value>.<base64 HMAC-SHA256, no padding>`.
 *
 * @param value - The cookie value.
 * @param secret - The secret given to `cookie-parser`.
 */
function signCookie(value: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
  return `${value}.${signature}`;
}

/** A parsed header value like `text/html;level=1;q=0.8`. */
interface HeaderValue {
  /** The value with its original case, e.g. `text/html` or `en-US`. */
  value: string;
  /** Parameters other than `q`, keys lower-cased. */
  params: Record<string, string>;
  q: number;
  /** Position in the header. */
  index: number;
}

/**
 * Splits a `,`-separated header into values with their parameters, the same
 * way `negotiator` does: quoted strings may contain `,` and `;`, the first
 * occurrence of a parameter wins and a missing or empty `q` is 1.
 */
function parseAcceptHeader(header: string): HeaderValue[] {
  const values: HeaderValue[] = [];
  const length = header.length;
  let index = 0;

  while (index < length) {
    index = skipWhitespace(header, index);
    const start = index;
    while (index < length && header[index] !== ";" && header[index] !== ",") index++;
    const value = header.slice(start, index).trimEnd();
    const params: Record<string, string> = Object.create(null);

    while (index < length && header[index] === ";") {
      index = skipWhitespace(header, index + 1);
      const keyStart = index;
      while (index < length && !";,=".includes(header[index])) index++;
      if (header[index] !== "=") continue;

      const key = header.slice(keyStart, index).trimEnd().toLowerCase();
      index = skipWhitespace(header, index + 1);
      let paramValue = "";

      if (header[index] === '"') {
        index++;
        while (index < length && header[index] !== '"') {
          if (header[index] === "\\" && index + 1 < length) index++;
          paramValue += header[index++];
        }
        index++;
        while (index < length && header[index] !== ";" && header[index] !== ",") index++;
      } else {
        const valueStart = index;
        while (index < length && header[index] !== ";" && header[index] !== ",") index++;
        paramValue = header.slice(valueStart, index).trimEnd();
      }

      if (params[key] === undefined) params[key] = paramValue;
    }

    const q = params.q;
    delete params.q;
    values.push({ value, params, q: q ? parseFloat(q) : 1, index: values.length });
    index++;
  }

  return values;
}

/** Skips spaces and tabs. */
function skipWhitespace(header: string, index: number) {
  while (header[index] === " " || header[index] === "\t") index++;
  return index;
}

/**
 * How well a client preference matches an offer: `s` is a specificity
 * bitmask, higher wins. `null` means no match.
 */
interface Priority {
  /** Index of the offer. */
  i: number;
  /** Index of the matching preference in the header. */
  o: number;
  q: number;
  s: number;
}

/** Compares a preference against an offer, the matchers of `negotiator`. */
type Specify = (offer: string, preference: HeaderValue, index: number) => Priority | null;

/** Media types: type (4), subtype (2) and parameters (1). */
const specifyMediaType: Specify = (offer, preference, index) => {
  const parsed = parseAcceptHeader(offer)[0];
  const slash = parsed?.value.indexOf("/") ?? -1;
  if (!parsed || slash === -1) return null;

  const [type, subtype] = splitMediaType(preference.value);
  const offerType = parsed.value.slice(0, slash).toLowerCase();
  const offerSubtype = parsed.value.slice(slash + 1).toLowerCase();
  let s = 0;

  if (type.toLowerCase() === offerType) s |= 4;
  else if (type !== "*") return null;

  if (subtype.toLowerCase() === offerSubtype) s |= 2;
  else if (subtype !== "*") return null;

  const keys = Object.keys(preference.params);
  if (keys.length > 0) {
    const matches = keys.every(
      (key) =>
        preference.params[key] === "*" ||
        (preference.params[key] || "").toLowerCase() === (parsed.params[key] || "").toLowerCase(),
    );
    if (!matches) return null;
    s |= 1;
  }

  return { i: index, o: preference.index, q: preference.q, s };
};

/** Charsets and encodings: exact (1) or `*`. */
const specifyToken: Specify = (offer, preference, index) => {
  let s = 0;
  if (preference.value.toLowerCase() === offer.toLowerCase()) s |= 1;
  else if (preference.value !== "*") return null;
  return { i: index, o: preference.index, q: preference.q, s };
};

/** Languages: exact (4), `en` offer for `en-US` (2), `en-US` offer for `en` (1), or `*`. */
const specifyLanguage: Specify = (offer, preference, index) => {
  const full = offer.toLowerCase();
  const prefix = full.split("-")[0];
  const accepted = preference.value.toLowerCase();
  let s = 0;

  if (accepted === full) s |= 4;
  else if (accepted.split("-")[0] === full) s |= 2;
  else if (accepted === prefix) s |= 1;
  else if (accepted !== "*") return null;

  return { i: index, o: preference.index, q: preference.q, s };
};

/** Splits `type/subtype`, `null` parts become empty strings. */
function splitMediaType(value: string): [string, string] {
  const slash = value.indexOf("/");
  return slash === -1 ? [value, ""] : [value.slice(0, slash), value.slice(slash + 1)];
}

/** Order of `negotiator`: quality, specificity, header position, offer position. */
function compareSpecs(a: { q: number; s?: number; o?: number; i: number }, b: typeof a) {
  return b.q - a.q || (b.s ?? 0) - (a.s ?? 0) || (a.o ?? 0) - (b.o ?? 0) || a.i - b.i || 0;
}

/**
 * Ranks `offers` by the client's `preferences` like `negotiator`: each offer
 * takes the most specific matching preference, offers with q=0 (or no
 * match) are dropped.
 *
 * @returns The acceptable offers, most preferred first.
 */
function rankOffers(preferences: HeaderValue[], offers: string[], specify: Specify): string[] {
  const priorities = offers.map((offer, index) => {
    let best: Priority = { i: index, o: -1, q: 0, s: 0 };
    for (const preference of preferences) {
      const spec = specify(offer, preference, index);
      if (spec && (best.s - spec.s || best.q - spec.q || best.o - spec.o) < 0) best = spec;
    }
    return best;
  });

  return priorities
    .filter((priority) => priority.q > 0)
    .sort(compareSpecs)
    .map((priority) => offers[priority.i]);
}

/** Accepted values of a header (q > 0) with their original case, most preferred first. */
function listAccepted(preferences: HeaderValue[]): string[] {
  return preferences
    .filter((preference) => preference.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((preference) => preference.value);
}

/**
 * Media types the `Accept` header allows, like `negotiator`. A missing
 * header accepts everything.
 *
 * @param offers - MIME types, or omit to list the accepted types.
 */
function preferredMediaTypes(accept: string | undefined, offers?: string[]): string[] {
  const preferences = parseAcceptHeader(accept === undefined ? "*/*" : accept).filter((p) =>
    p.value.includes("/"),
  );
  if (!offers) return listAccepted(preferences);
  return rankOffers(preferences, offers, specifyMediaType);
}

/** Charsets the `Accept-Charset` header allows. A missing header accepts all. */
function preferredCharsets(accept: string | undefined, offers?: string[]): string[] {
  const preferences = parseAcceptHeader(accept === undefined ? "*" : accept).filter((p) => p.value);
  if (!offers) return listAccepted(preferences);
  return rankOffers(preferences, offers, specifyToken);
}

/**
 * Encodings the `Accept-Encoding` header allows. `identity` is acceptable
 * unless the header refuses it (directly or through `*`), and a missing
 * header only allows `identity`.
 */
function preferredEncodings(accept: string | undefined, offers?: string[]): string[] {
  const parsed = parseAcceptHeader(accept || "");
  const preferences = parsed.filter((p) => p.value);
  const coversIdentity = preferences.some((p) => specifyToken("identity", p, 0));

  if (!coversIdentity) {
    const minQuality = Math.min(1, ...preferences.map((p) => p.q || 1));
    preferences.push({ value: "identity", params: Object.create(null), q: minQuality, index: parsed.length });
  }

  if (!offers) return listAccepted(preferences);
  return rankOffers(preferences, offers, specifyToken);
}

/** Languages the `Accept-Language` header allows. A missing header accepts all. */
function preferredLanguages(accept: string | undefined, offers?: string[]): string[] {
  const preferences = parseAcceptHeader(accept === undefined ? "*" : accept).filter((p) => p.value);
  if (!offers) return listAccepted(preferences);
  return rankOffers(preferences, offers, specifyLanguage);
}

/**
 * MIME type for an extension or file name, like `mime-types`' `lookup`:
 * `json`, `.json` and `data.json` give `application/json`. `false` when unknown.
 */
function lookupMime(value: string): string | false {
  const extension = value.slice(value.lastIndexOf(".") + 1).toLowerCase();
  return MIME_TYPES[extension] || false;
}

/** Expands extensions to MIME types: `json` becomes `application/json`. */
function normalizeType(type: string): string {
  if (type.includes("/")) return type;
  return MIME_TYPES[type.replace(/^\./, "").toLowerCase()] || type;
}

/**
 * Full `Content-Type` value for a type or extension, mirroring the
 * `mime-types` `contentType` helper: adds a utf-8 charset to text and
 * JSON/JavaScript types.
 */
function contentType(type: string): string {
  const mime = normalizeType(type);
  if (!mime.includes("/") || mime.includes("charset")) return mime;

  const base = mime.toLowerCase();
  if (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/javascript" ||
    base.endsWith("+json")
  ) {
    return `${mime}; charset=utf-8`;
  }

  return mime;
}

/** A valid `type/subtype`, the rule `media-typer` uses. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The media type of a `Content-Type` header, lower-cased and without
 * parameters, or `null` when it is missing or invalid.
 */
function mediaTypeOf(header: string | undefined): string | null {
  if (!header) return null;
  const semicolon = header.indexOf(";");
  const type = (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : null;
}

/**
 * Matches a media type against a `type-is` pattern such as `json`,
 * `application/json`, `text/*`, `+json`, `urlencoded` or `multipart`.
 *
 * @param actual - A media type from {@link mediaTypeOf}.
 * @param pattern - The pattern to test.
 */
function matchContentType(actual: string, pattern: string): boolean {
  let expected: string | false;
  if (pattern === "urlencoded") expected = "application/x-www-form-urlencoded";
  else if (pattern === "multipart") expected = "multipart/*";
  else if (pattern.startsWith("+")) expected = `*/*${pattern}`;
  else expected = pattern.includes("/") ? pattern : lookupMime(pattern);
  if (!expected) return false;

  const [actualType, actualSub, ...actualRest] = actual.split("/");
  const [expectedType, expectedSub, ...expectedRest] = expected.split("/");

  if (actualSub === undefined || expectedSub === undefined) return false;
  if (actualRest.length > 0 || expectedRest.length > 0) return false;
  if (expectedType !== "*" && expectedType !== actualType) return false;

  if (expectedSub.startsWith("*+")) {
    return expectedSub.length <= actualSub.length + 1 && actualSub.endsWith(expectedSub.slice(1));
  }

  return expectedSub === "*" || expectedSub === actualSub;
}

/**
 * Sets the `charset` parameter of a `Content-Type`, like Express's
 * `setCharset`: the type is lower-cased and parameters are sorted.
 */
function setCharset(type: string, charset: string): string {
  // res.send() always asks for utf-8 and responses use a handful of types,
  // so those results are cached by type.
  if (charset !== "utf-8") return computeCharset(type, charset);
  const cached = utf8Cache.get(type);
  if (cached !== undefined) return cached;

  const result = computeCharset(type, charset);
  if (utf8Cache.size >= 256) utf8Cache.clear();
  utf8Cache.set(type, result);
  return result;
}

/** Results of {@link setCharset} for utf-8, by type. */
const utf8Cache = new Map<string, string>();

function computeCharset(type: string, charset: string): string {
  // Fast path for the common case, e.g. what res.json() and res.type() set.
  if (type.endsWith(`; charset=${charset}`) && SIMPLE_TYPE.test(type.slice(0, -charset.length - 10))) return type;

  const [base, ...rest] = type.split(";");
  const params: Record<string, string> = Object.create(null);

  for (const param of rest) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    params[key] = value;
  }

  params.charset = charset;

  let result = base.trim().toLowerCase();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    result += `; ${key}=${TOKEN.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`}`;
  }
  return result;
}

/** A lower-case media type without parameters. */
const SIMPLE_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** An HTTP token (RFC 7230). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** An inclusive byte range. */
interface Range {
  start: number;
  end: number;
}

/** Parsed ranges plus the range unit, usually `bytes`. */
type Ranges = Range[] & { type: string };

/**
 * Parses a `Range` header. `bytes=-500` means the last 500 bytes.
 *
 * @param size - Size of the resource in bytes.
 * @param header - The raw `Range` header.
 * @param options - `combine` merges overlapping and adjacent ranges.
 * @returns The ranges, `-1` when unsatisfiable or `-2` when malformed.
 */
function parseRange(
  size: number,
  header: string,
  options: { combine?: boolean } = {},
): Ranges | -1 | -2 {
  const eq = header.indexOf("=");
  if (eq === -1) return -2;

  const ranges = [] as unknown as Ranges;
  ranges.type = header.slice(0, eq).trim();

  // Same rules as the `range-parser` package: one malformed range makes the
  // whole header malformed, unsatisfiable ranges are skipped.
  for (const part of header.slice(eq + 1).split(",")) {
    const dash = part.indexOf("-");
    if (dash === -1) return -2;

    const rawStart = part.slice(0, dash).trim();
    const rawEnd = part.slice(dash + 1).trim();
    let start = parsePosition(rawStart);
    let end = parsePosition(rawEnd);

    if (rawStart === "") {
      start = size - end;
      end = size - 1;
    } else if (rawEnd === "") {
      end = size - 1;
    }

    if (end > size - 1) end = size - 1;
    if (Number.isNaN(start) || Number.isNaN(end)) return -2;
    if (start > end || start < 0) continue;

    ranges.push({ start, end });
  }

  if (ranges.length < 1) return -1;

  return options.combine ? combineRanges(ranges) : ranges;
}

/** Parses a range position, only plain digits are allowed. */
function parsePosition(value: string) {
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

/** Merges overlapping and adjacent ranges, sorted by start. */
function combineRanges(ranges: Ranges): Ranges {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const combined = [] as unknown as Ranges;
  combined.type = ranges.type;

  for (const range of sorted) {
    const last = combined[combined.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      combined.push({ ...range });
    }
  }

  return combined;
}

/**
 * Conditional GET check with the rules of the `fresh` package: when
 * `If-None-Match` is present it alone decides, `*` matches any response,
 * otherwise `If-Modified-Since` must be a date no older than
 * `Last-Modified`. `Cache-Control: no-cache` always forces a full response.
 *
 * @returns `true` when the client's cached copy is still valid, so the
 * response can be a 304.
 */
function isFresh(
  reqHeaders: IncomingHttpHeaders,
  resHeaders: OutgoingHttpHeaders,
): boolean {
  const modifiedSince = reqHeaders["if-modified-since"];
  const noneMatch = reqHeaders["if-none-match"];

  if (!modifiedSince && !noneMatch) return false;

  const cacheControl = reqHeaders["cache-control"];
  if (cacheControl && /(?:^|,)\s*no-cache\s*(?:,|$)/.test(cacheControl))
    return false;

  if (noneMatch) {
    if (noneMatch === "*") return true;

    const etag = resHeaders["etag"] as string | undefined;
    if (!etag) return false;

    return parseTokenList(noneMatch).some(
      (tag) => tag === etag || tag === `W/${etag}` || `W/${tag}` === etag,
    );
  }

  const lastModified = resHeaders["last-modified"] as string | undefined;
  if (!lastModified) return false;
  return Date.parse(lastModified) <= Date.parse(modifiedSince!);
}

/**
 * Precondition check with the rules of Express's `send`: `If-Match` must
 * list the response's ETag (or be `*`), otherwise `If-Unmodified-Since` must
 * be a date no older than `Last-Modified`.
 *
 * @returns `true` when the request should fail with a 412.
 */
function isPreconditionFailure(
  reqHeaders: IncomingHttpHeaders,
  resHeaders: OutgoingHttpHeaders,
): boolean {
  const match = reqHeaders["if-match"];
  if (match) {
    const etag = resHeaders["etag"] as string | undefined;
    return (
      !etag ||
      (match !== "*" &&
        parseTokenList(match).every(
          (tag) => tag !== etag && tag !== `W/${etag}` && `W/${tag}` !== etag,
        ))
    );
  }

  const unmodifiedSince = Date.parse(reqHeaders["if-unmodified-since"] ?? "");
  if (!Number.isNaN(unmodifiedSince)) {
    const lastModified = Date.parse((resHeaders["last-modified"] as string | undefined) ?? "");
    return Number.isNaN(lastModified) || lastModified > unmodifiedSince;
  }

  return false;
}

/**
 * `If-Range` check with the rules of Express's `send`: an ETag must be the
 * response's, a date must be no older than `Last-Modified`.
 *
 * @returns `true` when a `Range` header may be honoured, `false` when the
 * client's copy is outdated and needs the whole file.
 */
function isRangeFresh(
  reqHeaders: IncomingHttpHeaders,
  resHeaders: OutgoingHttpHeaders,
): boolean {
  const ifRange = reqHeaders["if-range"] as string | undefined;
  if (!ifRange) return true;

  if (ifRange.includes('"')) {
    const etag = resHeaders["etag"] as string | undefined;
    return Boolean(etag && ifRange.includes(etag));
  }

  const lastModified = resHeaders["last-modified"] as string | undefined;
  return Date.parse(lastModified ?? "") <= Date.parse(ifRange);
}

/** Splits a `,`-separated header like `fresh` and `vary` do, trimming spaces. */
function parseTokenList(header: string): string[] {
  return header.split(",").map((token) => token.trim());
}

/**
 * Weak ETag in the same shape Express generates: `W/"<size>-<hash>"`.
 *
 * @param body - The response body.
 * @param length - Byte length of the body, computed when omitted.
 */
function generateETag(
  body: string | Buffer,
  length = typeof body === "string" ? Buffer.byteLength(body) : body.length,
): string {
  if (length === 0) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';

  const hash = createHash("sha1")
    .update(body)
    .digest("base64")
    .substring(0, 27);

  return `W/"${length.toString(16)}-${hash}"`;
}

/** Percent-encodes a URL without double-encoding existing escapes. */
function encodeUrl(url: string): string {
  return encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
}

/** Escapes `&`, `<`, `>`, `"` and `'` for use in HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `Content-Disposition: attachment` value, like the `content-disposition`
 * package: tokens are written as-is, other ASCII names quoted, and names with
 * non-ASCII characters or `%XX` sequences get an ASCII fallback plus an
 * RFC 5987 `filename*`.
 */
function contentDisposition(filename?: string): string {
  if (filename === undefined) return "attachment";

  if (/^[\x20-\x7e]*$/.test(filename) && !/%[0-9A-Fa-f]{2}/.test(filename)) {
    return `attachment; filename=${quoteParameter(filename)}`;
  }

  const fallback = filename.replace(/[^\x20-\x7e]/g, "?");
  const extended = encodeURIComponent(filename).replace(
    /[\x00-\x20"'()*,/:;<=>?@[\\\]{}\x7f]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename=${quoteParameter(fallback)}; filename*=UTF-8''${extended}`;
}

/** A header parameter value: a token as-is, otherwise a quoted string. */
function quoteParameter(value: string): string {
  return TOKEN.test(value) ? value : `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export {
  serializeCookie,
  signCookie,
  preferredMediaTypes,
  preferredCharsets,
  preferredEncodings,
  preferredLanguages,
  lookupMime,
  mediaTypeOf,
  setCharset,
  parseTokenList,
  normalizeType,
  contentType,
  matchContentType,
  parseRange,
  isFresh,
  isPreconditionFailure,
  isRangeFresh,
  generateETag,
  encodeUrl,
  escapeHtml,
  contentDisposition,
  Ranges,
};

/**
 * Parses a query string with Node's `querystring.parse`, which is Express 5's
 * default "simple" query parser: repeated keys become arrays, at most 1000
 * keys are read, and malformed escapes are kept as they are.
 *
 * The result has no prototype, so keys such as `__proto__` or `toString`
 * are plain data and can't change the object.
 *
 * @param search - Everything after the first `?`.
 */
function parseQuery(search: string): Record<string, string | string[]> {
  return parse(search) as Record<string, string | string[]>;
}

export { parseQuery };
