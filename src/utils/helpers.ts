import { CookieOptions } from "../types/cookie-options";

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

export { serializeCookie };
