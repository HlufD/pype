/** Options accepted by `res.cookie()` and `res.clearCookie()`. */
export interface CookieOptions {
  /** Domain the cookie is sent to. */
  domain?: string;
  /** Encodes the cookie value. Defaults to `encodeURIComponent`. */
  encode?: (val: string) => string;
  /** Absolute expiry date. */
  expires?: Date;
  /** Hides the cookie from client-side JavaScript. */
  httpOnly?: boolean;
  /** Lifetime in milliseconds, sets both `Max-Age` and `Expires`. */
  maxAge?: number;
  /** Adds the `Partitioned` attribute (CHIPS). */
  partitioned?: boolean;
  /** Path the cookie is sent for. Defaults to `/`. */
  path?: string;
  /** `Priority` attribute. */
  priority?: "low" | "medium" | "high";
  /** Only send the cookie over HTTPS. */
  secure?: boolean;
  /** Sign the value with the secret given to `cookie-parser`. */
  signed?: boolean;
  /** `SameSite` attribute, `true` means `Strict`. */
  sameSite?: boolean | "lax" | "strict" | "none";
}
