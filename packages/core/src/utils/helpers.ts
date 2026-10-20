import { createHash, createHmac } from "crypto";
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "http";
import { CookieOptions } from "../types/cookie-options";
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
 * @throws TypeError when the name, encoded value, domain or path contains
 * characters that would break or inject into the header, or `priority` or
 * `sameSite` isn't one of the allowed values.
 */
function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
) {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError(`Invalid cookie name: ${JSON.stringify(name)}`);
  }

  const encode = options.encode || encodeURIComponent;
  const encoded = encode(value);

  if (!COOKIE_VALUE.test(encoded)) {
    throw new TypeError(`Invalid cookie value for ${name}`);
  }

  for (const attribute of ["domain", "path"] as const) {
    const attributeValue = options[attribute];
    if (attributeValue !== undefined && !COOKIE_ATTRIBUTE.test(attributeValue)) {
      throw new TypeError(`Invalid cookie ${attribute}: ${JSON.stringify(attributeValue)}`);
    }
  }

  if (options.maxAge != null && !Number.isFinite(options.maxAge)) {
    throw new TypeError("Cookie maxAge must be a finite number");
  }

  if (options.expires && Number.isNaN(options.expires.getTime())) {
    throw new TypeError("Cookie expires must be a valid date");
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
    if (!priority) throw new TypeError(`Invalid cookie priority: ${options.priority}`);
    cookie += `; Priority=${priority}`;
  }

  if (options.sameSite) {
    const sameSite =
      options.sameSite === true
        ? "Strict"
        : SAME_SITE.get(String(options.sameSite).toLowerCase());
    if (!sameSite) throw new TypeError(`Invalid cookie sameSite: ${options.sameSite}`);
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

/** One entry of a header like `Accept`, e.g. `text/html;q=0.8`. */
interface Preference {
  value: string;
  q: number;
  index: number;
}

/**
 * Parses headers like `Accept` or `Accept-Language` into lower-cased values
 * with their q-weights and original positions.
 */
function parsePreferences(header: string): Preference[] {
  return header
    .split(",")
    .map((part, index) => {
      const [value, ...params] = part.split(";").map((p) => p.trim());
      let q = 1;

      for (const param of params) {
        if (param.startsWith("q=")) {
          const parsed = parseFloat(param.slice(2));
          q = Number.isNaN(parsed) ? 0 : parsed;
        }
      }

      return { value: value.toLowerCase(), q, index };
    })
    .filter((pref) => pref.value !== "");
}

/**
 * Returns how specifically a client `pattern` matches a server `offer`
 * (higher is more specific), or -1 for no match.
 */
type Matcher = (pattern: string, offer: string) => number;

/**
 * Ranks `offers` by the client's preferences.
 *
 * Each offer takes the q-value of the most specific matching preference, so
 * `text/html;q=0` rejects `text/html` even when
 * the header also accepts every type. Offers with q=0 are dropped.
 *
 * @param header - The raw `Accept*` header.
 * @param offers - Values the server can produce.
 * @param match - Compares a preference with an offer.
 * @param defaultQ - q-value for offers no preference mentions, they are
 * dropped when it returns `undefined`.
 * @returns Acceptable offers, most preferred first.
 */
function negotiate(
  header: string,
  offers: string[],
  match: Matcher,
  defaultQ?: (offer: string) => number | undefined,
): string[] {
  const preferences = parsePreferences(header);

  return offers
    .map((offer, order) => {
      let best: { q: number; specificity: number; index: number } | null =
        null;

      for (const pref of preferences) {
        const specificity = match(pref.value, offer.toLowerCase());
        if (specificity < 0) continue;

        if (
          !best ||
          specificity > best.specificity ||
          (specificity === best.specificity && pref.q > best.q)
        ) {
          best = { q: pref.q, specificity, index: pref.index };
        }
      }

      if (!best) {
        const q = defaultQ?.(offer.toLowerCase());
        if (q === undefined) return null;
        best = { q, specificity: -1, index: preferences.length };
      }

      return { offer, order, ...best };
    })
    .filter(
      (ranked): ranked is NonNullable<typeof ranked> =>
        ranked !== null && ranked.q > 0,
    )
    .sort((a, b) => b.q - a.q || a.index - b.index || a.order - b.order)
    .map((ranked) => ranked.offer);
}

/** Values the client accepts (q > 0), most preferred first. */
function acceptedValues(header: string): string[] {
  return parsePreferences(header)
    .filter((pref) => pref.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((pref) => pref.value);
}

/** {@link Matcher} for media types: exact > `type/*` > any type. */
function matchMediaType(pattern: string, offer: string): number {
  const [patternType, patternSub] = pattern.split("/");
  const [offerType, offerSub] = offer.split(";")[0].trim().split("/");

  if (patternType === "*" && patternSub === "*") return 0;
  if (patternType !== offerType) return -1;
  if (patternSub === "*") return 1;
  return patternSub === offerSub ? 2 : -1;
}

/** {@link Matcher} for charsets and encodings: exact > `*`. */
function matchToken(pattern: string, offer: string): number {
  if (pattern === "*") return 0;
  return pattern === offer ? 1 : -1;
}

/**
 * {@link Matcher} for languages: `en` matches `en-US` and vice versa, an
 * exact match ranks higher.
 */
function matchLanguage(pattern: string, offer: string): number {
  if (pattern === "*") return 0;
  if (pattern === offer) return 2;

  const patternPrimary = pattern.split("-")[0];
  const offerPrimary = offer.split("-")[0];
  return patternPrimary === offerPrimary ? 1 : -1;
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

/**
 * Matches a request `Content-Type` against a `type-is` style pattern such as
 * `json`, `application/json`, `text/*` or `+json`.
 *
 * @param actual - The request's media type, without parameters.
 * @param pattern - The pattern to test.
 */
function matchContentType(actual: string, pattern: string): boolean {
  let expected = pattern.toLowerCase();
  if (expected.startsWith("+")) expected = `*/*${expected}`;
  else expected = normalizeType(expected).toLowerCase();

  const [actualType, actualSub] = actual.toLowerCase().split("/");
  const [expectedType, expectedSub] = expected.split("/");

  if (!actualSub || !expectedSub) return false;
  if (expectedType !== "*" && expectedType !== actualType) return false;

  if (expectedSub.startsWith("*+")) {
    return actualSub.endsWith(expectedSub.slice(1));
  }

  return expectedSub === "*" || expectedSub === actualSub;
}

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
 * Conditional GET check with the same rules as the `fresh` package.
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

  if (noneMatch && noneMatch !== "*") {
    const etag = resHeaders["etag"] as string | undefined;
    if (!etag) return false;

    const matches = noneMatch
      .split(",")
      .map((tag) => tag.trim())
      .some(
        (tag) =>
          tag === etag || tag === `W/${etag}` || `W/${tag}` === etag,
      );

    if (!matches) return false;
  }

  if (modifiedSince) {
    const lastModified = resHeaders["last-modified"] as string | undefined;
    if (!lastModified) return false;
    if (Date.parse(lastModified) > Date.parse(modifiedSince)) return false;
  }

  return true;
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
 * `Content-Disposition: attachment` value, with an RFC 5987 `filename*` for
 * non-ASCII file names.
 */
function contentDisposition(filename?: string): string {
  if (!filename) return "attachment";

  const ascii = filename
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/["\\]/g, "\\$&");
  let header = `attachment; filename="${ascii}"`;

  if (/[^\x20-\x7e]/.test(filename)) {
    header += `; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  return header;
}

export {
  serializeCookie,
  signCookie,
  negotiate,
  acceptedValues,
  matchMediaType,
  matchToken,
  matchLanguage,
  normalizeType,
  contentType,
  matchContentType,
  parseRange,
  isFresh,
  generateETag,
  encodeUrl,
  escapeHtml,
  contentDisposition,
  Ranges,
};

/**
 * Parses a query string. Repeated keys become arrays.
 *
 * The result has no prototype, like Node's `querystring.parse`, so keys such
 * as `__proto__` or `toString` are plain data and can't change the object.
 *
 * @param search - The query string without the leading `?`.
 */
function parseQuery(search: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = Object.create(null);

  for (const [key, value] of new URLSearchParams(search)) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }

  return query;
}

export { parseQuery };
