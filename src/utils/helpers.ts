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

function parseAcceptHeader(header: string) {
  const types = header.split(",").map((type) => type.trim());
  return types
    .map((type) => {
      let q = 1.0;
      const [mime, priority] = type.split(";");
      if (priority && priority.trim().startsWith("q=")) {
        q = parseFloat(priority.trim().substring(2));
      }
      return { mime: mime.trim(), q };
    })
    .sort((a, b) => b.q - a.q);
}

function matchTypes(clientType: string, serverType: string): boolean {
  if (clientType === "*/*") return true;

  const [clientMainType, clientSub] = clientType.split("/");
  const [serverMainType, serverSub] = serverType.split("/");

  if (
    clientMainType === serverMainType &&
    (clientSub === serverSub || clientSub === "*")
  )
    return true;

  return false;
}

export { serializeCookie, parseAcceptHeader, matchTypes };
