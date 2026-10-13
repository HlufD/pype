import { createHash, createHmac } from "crypto";
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "http";
import { CookieOptions } from "../types/cookie-options";
import { MIME_TYPES } from "../enums/mime-types";

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
) {
  const encode = options.encode || encodeURIComponent;
  let cookie = `${name}=${encode(value)}`;

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
    const priority = options.priority.toLowerCase();
    cookie += `; Priority=${priority.charAt(0).toUpperCase()}${priority.slice(1)}`;
  }

  if (options.sameSite) {
    const sameSite =
      options.sameSite === true
        ? "Strict"
        : typeof options.sameSite === "string"
          ? options.sameSite.charAt(0).toUpperCase() +
            options.sameSite.slice(1).toLowerCase()
          : undefined;

    if (sameSite) cookie += `; SameSite=${sameSite}`;
  }

  return cookie;
}

// Same format as the cookie-signature package used by Express and
// cookie-parser: "<value>.<base64 HMAC-SHA256 without padding>".
function signCookie(value: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
  return `${value}.${signature}`;
}

interface Preference {
  value: string;
  q: number;
  index: number;
}

// Parses headers like Accept / Accept-Language into values with q-weights.
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

// Returns how specifically `pattern` matches `offer`, or -1 for no match.
type Matcher = (pattern: string, offer: string) => number;

// Ranks `offers` by the client's preferences. Each offer takes the q-value of
// the most specific matching preference, so "text/html;q=0, */*" rejects
// text/html. Offers with q=0 are dropped.
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

// Values the client accepts (q > 0), most preferred first.
function acceptedValues(header: string): string[] {
  return parsePreferences(header)
    .filter((pref) => pref.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((pref) => pref.value);
}

function matchMediaType(pattern: string, offer: string): number {
  const [patternType, patternSub] = pattern.split("/");
  const [offerType, offerSub] = offer.split(";")[0].trim().split("/");

  if (patternType === "*" && patternSub === "*") return 0;
  if (patternType !== offerType) return -1;
  if (patternSub === "*") return 1;
  return patternSub === offerSub ? 2 : -1;
}

function matchToken(pattern: string, offer: string): number {
  if (pattern === "*") return 0;
  return pattern === offer ? 1 : -1;
}

// "en" matches "en-US" and vice versa, an exact match ranks higher.
function matchLanguage(pattern: string, offer: string): number {
  if (pattern === "*") return 0;
  if (pattern === offer) return 2;

  const patternPrimary = pattern.split("-")[0];
  const offerPrimary = offer.split("-")[0];
  return patternPrimary === offerPrimary ? 1 : -1;
}

// "json" -> "application/json", "text/html" stays as is.
function normalizeType(type: string): string {
  if (type.includes("/")) return type;
  return MIME_TYPES[type.replace(/^\./, "").toLowerCase()] || type;
}

// Mirrors the mime-types `contentType` helper: adds a utf-8 charset to text
// and JSON/JavaScript types.
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

// Matches a request Content-Type against a type-is style pattern:
// "json", "application/json", "text/*", "*/*" or "+json".
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

interface Range {
  start: number;
  end: number;
}

type Ranges = Range[] & { type: string };

// Parses a Range header. Returns -2 when malformed, -1 when unsatisfiable.
function parseRange(
  size: number,
  header: string,
  options: { combine?: boolean } = {},
): Ranges | -1 | -2 {
  const eq = header.indexOf("=");
  if (eq === -1) return -2;

  const ranges = [] as unknown as Ranges;
  ranges.type = header.slice(0, eq).trim();

  for (const part of header.slice(eq + 1).split(",")) {
    const [rawStart, rawEnd] = part.trim().split("-");
    let start = parseInt(rawStart, 10);
    let end = parseInt(rawEnd, 10);

    if (Number.isNaN(start)) {
      // "-500" means the last 500 bytes.
      start = size - end;
      end = size - 1;
    } else if (Number.isNaN(end)) {
      end = size - 1;
    }

    if (end > size - 1) end = size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0)
      continue;

    ranges.push({ start, end });
  }

  if (ranges.length < 1) return -1;

  return options.combine ? combineRanges(ranges) : ranges;
}

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

// Conditional GET check, same rules as the `fresh` package.
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

// Weak ETag in the same shape Express generates: W/"<size>-<hash>".
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

// Percent-encodes a URL without double-encoding existing escapes.
function encodeUrl(url: string): string {
  return encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Content-Disposition with an RFC 5987 fallback for non-ASCII file names.
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

function parseQuery(search: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};

  for (const [key, value] of new URLSearchParams(search)) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }

  return query;
}

export { parseQuery };
