import { describe, expect, it } from "vitest";
import { sign } from "cookie-signature";
import {
  contentDisposition,
  contentType,
  escapeHtml,
  generateETag,
  isFresh,
  matchContentType,
  mediaTypeOf,
  parseQuery,
  preferredCharsets,
  preferredEncodings,
  preferredLanguages,
  preferredMediaTypes,
  setCharset,
  parseRange,
  serializeCookie,
  signCookie,
} from "../src/utils/helpers";

describe("serializeCookie", () => {
  it("rejects values the encoder leaves unsafe", () => {
    expect(() => serializeCookie("a", "x;y", { encode: (v) => v })).toThrow("argument val is invalid");
  });

  it("rejects invalid maxAge and expires", () => {
    expect(() => serializeCookie("a", "1", { maxAge: Infinity })).toThrow("option maxAge is invalid");
    expect(() => serializeCookie("a", "1", { expires: new Date("nope") })).toThrow("option expires is invalid");
  });

  it("rejects attributes that would inject into the header", () => {
    expect(() => serializeCookie("a", "1", { domain: "x.com; Secure" })).toThrow("domain");
    expect(() => serializeCookie("a", "1", { path: "/\r\nX: y" })).toThrow("path");
  });
});

describe("serializeCookie priority and sameSite", () => {
  it("accepts the allowed values in any case", () => {
    expect(serializeCookie("a", "b", { priority: "HIGH" as any })).toContain("; Priority=High");
    expect(serializeCookie("a", "b", { sameSite: "none" })).toContain("; SameSite=None");
    expect(serializeCookie("a", "b", { sameSite: "Lax" as any })).toContain("; SameSite=Lax");
    expect(serializeCookie("a", "b", { sameSite: true })).toContain("; SameSite=Strict");
    expect(serializeCookie("a", "b", { sameSite: false })).not.toContain("SameSite");
  });

  it.each(["Bogus", "constructor", "toString", "low; HttpOnly"])(
    "throws a TypeError for the invalid value %s, like the cookie package",
    (value) => {
      expect(() => serializeCookie("a", "b", { priority: value as any })).toThrow(TypeError);
      expect(() => serializeCookie("a", "b", { sameSite: value as any })).toThrow(TypeError);
    },
  );
});

describe("signCookie", () => {
  it("matches the cookie-signature package", () => {
    for (const value of ["hello", "", "j:{\"a\":1}", "ünïcode"]) {
      expect(signCookie(value, "secret")).toBe(sign(value, "secret"));
    }
  });
});

describe("content negotiation", () => {
  it("ranks media types by quality, then specificity, then header order", () => {
    expect(preferredMediaTypes("text/*;q=0.5, text/html", ["text/plain", "text/html"])).toEqual(["text/html", "text/plain"]);
    expect(preferredMediaTypes("*/*, text/html;q=0", ["text/html", "image/png"])).toEqual(["image/png"]);
    expect(preferredMediaTypes("text/html;level=1", ["text/html", "text/html;level=1"])).toEqual(["text/html;level=1"]);
    expect(preferredMediaTypes(undefined, ["image/png"])).toEqual(["image/png"]);
    expect(preferredMediaTypes("a/b;q=bad", ["a/b"])).toEqual([]);
  });

  it("lists accepted values with their original case", () => {
    expect(preferredMediaTypes("TEXT/HTML, application/json;q=0.5, image/*;q=0")).toEqual(["TEXT/HTML", "application/json"]);
    expect(preferredLanguages("EN-us, fr;q=0.5")).toEqual(["EN-us", "fr"]);
    expect(preferredCharsets(undefined)).toEqual(["*"]);
  });

  it("keeps quoted commas and semicolons inside parameters", () => {
    expect(preferredMediaTypes('text/html;x="a,b;c", image/png', ["image/png", 'text/html;x="a,b;c"'])).toEqual([
      'text/html;x="a,b;c"',
      "image/png",
    ]);
  });

  it("makes identity acceptable unless refused, and the only encoding without a header", () => {
    expect(preferredEncodings(undefined)).toEqual(["identity"]);
    expect(preferredEncodings("gzip")).toEqual(["gzip", "identity"]);
    // The implied identity takes the lowest q-value of the header, like negotiator.
    expect(preferredEncodings("gzip;q=0.5", ["identity", "gzip"])).toEqual(["gzip", "identity"]);
    expect(preferredEncodings("gzip, br;q=0.2")).toEqual(["gzip", "br", "identity"]);
    expect(preferredEncodings("gzip, identity;q=0")).toEqual(["gzip"]);
    expect(preferredEncodings("*")).toEqual(["*"]);
    expect(preferredEncodings("*;q=0", ["identity"])).toEqual([]);
  });

  it("matches languages by prefix in one direction per specificity", () => {
    expect(preferredLanguages("en", ["en-US"])).toEqual(["en-US"]);
    expect(preferredLanguages("en-US", ["en"])).toEqual(["en"]);
    expect(preferredLanguages("en-GB", ["en-US"])).toEqual([]);
    expect(preferredLanguages("en-US, en;q=0.5", ["en", "en-US"])).toEqual(["en-US", "en"]);
  });
});

describe("content types", () => {
  it("contentType adds charsets where Express does", () => {
    expect(contentType("json")).toBe("application/json; charset=utf-8");
    expect(contentType("application/ld+json")).toBe("application/ld+json; charset=utf-8");
    expect(contentType("png")).toBe("image/png");
    expect(contentType("text/html; charset=latin1")).toBe("text/html; charset=latin1");
    expect(contentType("unknownext")).toBe("unknownext");
  });

  it("mediaTypeOf validates and lower-cases the type", () => {
    expect(mediaTypeOf("Text/HTML; charset=utf-8")).toBe("text/html");
    expect(mediaTypeOf("invalid")).toBeNull();
    expect(mediaTypeOf("text/")).toBeNull();
    expect(mediaTypeOf(undefined)).toBeNull();
  });

  it("setCharset replaces the charset and sorts parameters like Express", () => {
    expect(setCharset("text/html", "utf-8")).toBe("text/html; charset=utf-8");
    expect(setCharset("Text/Plain; Format=flowed; charset=latin1", "utf-8")).toBe("text/plain; charset=utf-8; format=flowed");
    expect(setCharset('text/plain; x="a b"', "utf-8")).toBe('text/plain; charset=utf-8; x="a b"');
  });

  it("matchContentType supports extensions, wildcards and suffixes", () => {
    expect(matchContentType("application/json", "json")).toBe(true);
    expect(matchContentType("text/csv", "text/*")).toBe(true);
    expect(matchContentType("application/vnd.api+json", "+json")).toBe(true);
    expect(matchContentType("application/vnd.api+json", "application/*+json")).toBe(true);
    expect(matchContentType("application/xml", "+json")).toBe(false);
    expect(matchContentType("text/plain", "image/*")).toBe(false);
    expect(matchContentType("invalid", "text/plain")).toBe(false);
    expect(matchContentType("application/x-www-form-urlencoded", "urlencoded")).toBe(true);
    expect(matchContentType("multipart/form-data", "multipart")).toBe(true);
    expect(matchContentType("text/plain", "unknownext")).toBe(false);
  });
});

describe("parseRange", () => {
  it("returns -2 for malformed and -1 for unsatisfiable headers", () => {
    expect(parseRange(100, "bytes")).toBe(-2);
    expect(parseRange(100, "bytes=200-300")).toBe(-1);
    expect(parseRange(100, "bytes=50-10")).toBe(-1);
  });

  it("parses open-ended and suffix ranges, clamping to the size", () => {
    expect([...(parseRange(100, "bytes=90-") as any)]).toEqual([{ start: 90, end: 99 }]);
    expect([...(parseRange(100, "bytes=-10") as any)]).toEqual([{ start: 90, end: 99 }]);
    expect([...(parseRange(100, "bytes=0-500") as any)]).toEqual([{ start: 0, end: 99 }]);
  });

  it("treats the whole header as malformed when one range is, like range-parser", () => {
    for (const header of ["bytes=garbage", "bytes=0-1,garbage", "bytes=5abc-10", "bytes=0-1x", "bytes=-", "bytes=1.5-3"]) {
      expect(parseRange(100, header)).toBe(-2);
    }
  });

  it("skips unsatisfiable ranges but keeps satisfiable ones", () => {
    expect([...(parseRange(100, "bytes=5-1,0-1") as any)]).toEqual([{ start: 0, end: 1 }]);
    expect([...(parseRange(100, "bytes= 0 - 4 ") as any)]).toEqual([{ start: 0, end: 4 }]);
  });

  it("combines overlapping and adjacent ranges", () => {
    const ranges = parseRange(100, "bytes=20-30, 0-10, 11-15, 25-40", { combine: true }) as any;
    expect(ranges.type).toBe("bytes");
    expect([...ranges]).toEqual([
      { start: 0, end: 15 },
      { start: 20, end: 40 },
    ]);
  });
});

describe("isFresh", () => {
  const lastModified = "Mon, 01 Jan 2024 00:00:00 GMT";

  it("is false without conditional headers or response validators", () => {
    expect(isFresh({}, { etag: '"a"' })).toBe(false);
    expect(isFresh({ "if-none-match": '"a"' }, {})).toBe(false);
    expect(isFresh({ "if-modified-since": lastModified }, {})).toBe(false);
  });

  it("compares strong and weak ETags", () => {
    expect(isFresh({ "if-none-match": '"a", "b"' }, { etag: '"b"' })).toBe(true);
    expect(isFresh({ "if-none-match": 'W/"a"' }, { etag: '"a"' })).toBe(true);
    expect(isFresh({ "if-none-match": '"a"' }, { etag: 'W/"a"' })).toBe(true);
    expect(isFresh({ "if-none-match": '"x"' }, { etag: '"a"' })).toBe(false);
    expect(isFresh({ "if-none-match": "*" }, { etag: '"a"' })).toBe(true);
  });

  it("compares modification dates", () => {
    const later = "Tue, 02 Jan 2024 00:00:00 GMT";
    expect(isFresh({ "if-modified-since": later }, { "last-modified": lastModified })).toBe(true);
    expect(isFresh({ "if-modified-since": lastModified }, { "last-modified": later })).toBe(false);
  });
});

describe("other helpers", () => {
  it("generateETag handles empty bodies and buffers", () => {
    expect(generateETag("")).toBe('W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"');
    expect(generateETag(Buffer.from("abc"))).toBe(generateETag("abc"));
  });

  it("escapeHtml escapes every special character", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("contentDisposition escapes quotes and backslashes", () => {
    expect(contentDisposition('a"b\\c.txt')).toBe('attachment; filename="a\\"b\\\\c.txt"');
  });

  it("parseQuery collects three or more repeated keys", () => {
    expect(parseQuery("a=1&a=2&a=3").a).toEqual(["1", "2", "3"]);
  });
});
