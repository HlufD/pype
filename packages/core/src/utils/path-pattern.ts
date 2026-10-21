/**
 * Route and mount paths with several params in one segment, like
 * `/:from-:to` or `/flights/:from.:to`. The tree only handles whole-segment
 * params, so these paths become regular expressions built the way Express
 * 5's `path-to-regexp` builds them.
 */

/** A piece of a path: text, a `:param` or the trailing `*`. */
type Token =
  | { type: "text"; value: string }
  | { type: "param"; name: string; optional: boolean }
  | { type: "wildcard" };

/** A whole-segment param, the only kind the tree handles. */
const WHOLE_SEGMENT_PARAM = /^:[A-Za-z_$][\w$]*\??$/;

/** A param name after the `:`. */
const PARAM_NAME = /[A-Za-z_$][\w$]*/y;

/** Whether a string path has a segment with a param and other text, or several params. */
export function hasMixedSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.includes(":") && !WHOLE_SEGMENT_PARAM.test(segment));
}

/** The param names of a path in order, `"*"` for the wildcard. */
export function pathKeys(path: string): string[] {
  const keys: string[] = [];
  for (const token of tokenize(path)) {
    if (token.type === "param") keys.push(token.name);
    else if (token.type === "wildcard") keys.push("*");
  }
  return keys;
}

/**
 * Compiles a path into a regular expression with one group per param, in
 * the order of {@link pathKeys}. Like `path-to-regexp`, the first param of
 * a segment takes anything but `/`, and a later one can't contain the text
 * just before it: `/:from-:to` matches `/a-b-c` as `a-b` and `c`.
 *
 * @param options.end - `false` for a mount path, which may continue after the match.
 * @throws When a param has no name, or two params have no text between them.
 */
export function compilePathPattern(
  path: string,
  options: { caseSensitive: boolean; strict: boolean; end: boolean },
): RegExp {
  let source = "";
  let backtrack = "";
  let paramInSegment = false;
  let previousWasCapture = false;

  for (const token of tokenize(path)) {
    if (token.type === "text") {
      source += escape(token.value);
      backtrack += token.value;
      if (token.value.includes("/")) paramInSegment = false;
      continue;
    }

    if (previousWasCapture && !backtrack) {
      const what = token.type === "param" ? `"${token.name}" param` : "wildcard";
      throw new TypeError(`Missing text before ${what}: ${path}`);
    }

    if (token.type === "wildcard") {
      source += "([^]*)";
    } else if (token.optional) {
      // `/:name?` as the last segment: the slash is optional with it.
      source = `${source.slice(0, -2)}(?:\\/(${negate("/", "")}+))?`;
    } else {
      source += paramInSegment
        ? `(${negate("/", backtrack)}+|${escape(backtrack)})`
        : `(${negate("/", "")}+)`;
    }

    paramInSegment = true;
    previousWasCapture = true;
    backtrack = "";
  }

  let pattern = `^${source}`;
  if (options.end) pattern += options.strict ? "$" : "(?:\\/)?$";
  return new RegExp(pattern, options.caseSensitive ? "" : "i");
}

/**
 * Splits a path into tokens, with Pype's syntax: `:name` params, an
 * optional `:name?` as the whole last segment, and a trailing `*`.
 *
 * @throws When a `:` has no valid name after it.
 */
function tokenize(path: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ type: "text", value: text });
    text = "";
  };

  for (let i = 0; i < path.length; i++) {
    const char = path[i];

    if (char === "*" && i === path.length - 1) {
      flush();
      tokens.push({ type: "wildcard" });
    } else if (char === ":") {
      PARAM_NAME.lastIndex = i + 1;
      const name = PARAM_NAME.exec(path)?.[0];
      if (!name) throw new TypeError(`Missing parameter name at index ${i}: ${path}`);

      i += name.length;
      const optional = path[i + 1] === "?" && i + 2 === path.length && path[i - name.length - 1] === "/";
      if (optional) i++;
      flush();
      tokens.push({ type: "param", name, optional });
    } else {
      text += char;
    }
  }
  flush();
  return tokens;
}

/** Escapes text for a regular expression. */
function escape(text: string) {
  return text.replace(/[.+*?^${}()[\]|/\\]/g, "\\$&");
}

/**
 * A character that is neither the delimiter nor the start of the text
 * before the param, as in `path-to-regexp`, so a param can't run into it.
 */
function negate(a: string, b: string): string {
  if (b.length > a.length) return negate(b, a);
  if (a === b) b = "";
  if (b.length > 1) return `(?:(?!${escape(a)}|${escape(b)})[^])`;
  if (a.length > 1) return `(?:(?!${escape(a)})[^${escape(b)}])`;
  return `[^${escape(a + b)}]`;
}
