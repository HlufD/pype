export interface CookieOptions {
  domain?: string;
  encode?: (val: string) => string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  partitioned?: boolean;
  path?: string;
  priority?: "low" | "medium" | "high";
  secure?: boolean;
  // Sign the value with the secret given to cookie-parser.
  signed?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
}
