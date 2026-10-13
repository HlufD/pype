import { ServerResponse, STATUS_CODES } from "http";
import type { Request } from "./request";
import { MIME_TYPES } from "../enums/mime-types";
import { serializeCookie } from "../utils/helpers";
import { CookieOptions } from "../types/cookie-options";

export class Response extends ServerResponse<Request> {
  status(code: number) {
    this.statusCode = code;
    return this;
  }

  sendStatus(code: number) {
    this.status(code);
    this.type("txt");
    this.send(STATUS_CODES[code] || String(code));
    return this;
  }

  send(body?: any) {
    if (this.writableEnded) return this;

    if (Buffer.isBuffer(body)) {
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "application/octet-stream");
      }
    } else if (typeof body === "object" && body !== null) {
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      body = JSON.stringify(body);
    } else if (typeof body === "number") {
      this.statusCode = body;
      body = String(body);
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
    } else if (typeof body === "string") {
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "text/html; charset=utf-8");
      }
    }

    if (!this.getHeader("Content-Length") && body != null) {
      const length =
        typeof body === "string"
          ? Buffer.byteLength(body)
          : Buffer.isBuffer(body)
            ? body.length
            : 0;

      if (length > 0) {
        this.setHeader("Content-Length", length.toString());
      }
    }

    this.end(body);
    return this;
  }

  json(data: Record<string, any>) {
    if (!this.getHeader("Content-Type"))
      this.setHeader("Content-Type", "application/json; charset=utf-8");

    this.send(data);
    return this;
  }

  get(field: string) {
    return this.getHeader(field);
  }

  set(field: string | Record<string, string>, value?: string) {
    if (typeof field === "string") {
      if (value === undefined)
        throw new Error("Value is required when field is a string");

      this.setHeader(field, value);
    } else {
      for (const key in field) {
        this.setHeader(key, field[key]);
      }
    }
    return this;
  }

  type(value: string) {
    if (!value) return this;

    let type = value.trim().toLowerCase();

    if (type.includes("/")) {
      this.setHeader("Content-Type", type);
      return this;
    }

    type = type.replace(/^\./, "");

    const mimeType = MIME_TYPES[type];

    let finalType = mimeType || "application/octet-stream";

    if (finalType.startsWith("text/") && !finalType.includes("charset")) {
      finalType += "; charset=utf-8";
    }

    this.setHeader("Content-Type", finalType);
    return this;
  }

  redirect(location: string) {
    if (!location || this.writableEnded) return this;

    this.status(302);
    this.set("Location", location);

    if (!this.get("Content-Type"))
      this.set("Content-Type", "text/plain; charset=utf-8");

    this.end(`Found. Redirecting to ${location}`);

    return this;
  }

  links(links: Record<string, string>) {
    if (!links || typeof links !== "object") {
      return this;
    }

    const existing = this.getHeader("Link");
    const linkValues: string[] = [];

    for (const rel in links) {
      const url = links[rel];

      if (typeof url !== "string") continue;

      linkValues.push(`<${url}>; rel="${rel}"`);
    }

    const newValue = linkValues.join(", ");

    if (existing) {
      this.setHeader("Link", `${existing}, ${newValue}`);
    } else {
      this.setHeader("Link", newValue);
    }

    return this;
  }

  location(location: string) {
    this.set("Location", location);
    return this;
  }

  cookie(name: string, value: any, options: CookieOptions = {}) {
    const val =
      typeof value === "object" ? JSON.stringify(value) : String(value);

    const serialized = serializeCookie(name, val, options);
    this.append("Set-Cookie", serialized);
    return this;
  }

  clearCookie(name: string, options: CookieOptions = {}) {
    const opts = { ...options };

    opts.expires = new Date(1);
    opts.maxAge = undefined;

    return this.cookie(name, "", opts);
  }

  append(field: string, value: any) {
    const prev = this.get(field);

    if (!prev) {
      this.set(field, value);
    } else if (Array.isArray(prev)) {
      this.setHeader(field, [...prev, value]);
    } else {
      this.setHeader(field, [prev as string, value]);
    }

    return this;
  }

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
    const match = this.req.accepts(...types);

    if (match) {
      this.type(match);
      return normalized[match]();
    }

    if (defaultHandler) {
      return defaultHandler();
    }

    return this.status(406).send("Not Acceptable");
  }
}
