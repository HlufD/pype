/**
 * A port of the parser of the `qs` package (6.16), which Express uses for
 * `urlencoded({ extended: true })` and the `"extended"` query parser, so Pype
 * parses nested keys the same way without a runtime dependency.
 *
 * Only parsing is ported, with the options Express and `body-parser` use.
 * Objects are created without a prototype (`qs`' `plainObjects`), and
 * `__proto__` keys are dropped as in `qs`.
 *
 * Copyright (c) 2014, Nathan LaFreniere and other contributors
 * (https://github.com/ljharb/qs/graphs/contributors). All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 * @packageDocumentation
 */

/** Options of {@link parseQs}, with `qs`' defaults. */
export interface QsOptions {
  /** Max elements in an array before it becomes an object. Default 20. */
  arrayLimit?: number;
  /** `"utf-8"` or `"iso-8859-1"`, how percent-escapes are decoded. Default `"utf-8"`. */
  charset?: "utf-8" | "iso-8859-1";
  /** Read the charset from a `utf8=` parameter, which is then dropped. Default `false`. */
  charsetSentinel?: boolean;
  /** Max nesting depth of keys. Default 5. */
  depth?: number;
  /** Decode `&#nnn;` entities in ISO-8859-1 values. Default `false`. */
  interpretNumericEntities?: boolean;
  /** Max parameters read, the rest is ignored. Default 1000. */
  parameterLimit?: number;
  /** Throw a `RangeError` instead of keeping deeper keys as one segment. Default `false`. */
  strictDepth?: boolean;
}

/** A parsed value: a string, or nested arrays and objects of them. */
export type QsValue = string | QsValue[] | { [key: string]: QsValue };

type Options = Required<QsOptions>;
type Obj = Record<string, any>;

const has = (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key);
const isArray = Array.isArray;

/** Objects that stand for arrays that grew past `arrayLimit`, mapped to their highest index. */
const overflow = new WeakMap<object, number>();

const markOverflow = <T extends object>(obj: T, maxIndex: number) => {
  overflow.set(obj, maxIndex);
  return obj;
};
const isOverflow = (obj: unknown): obj is Obj => typeof obj === "object" && obj !== null && overflow.has(obj);
const getMaxIndex = (obj: object) => overflow.get(obj)!;

const createObject = (): Obj => Object.create(null);

/** Sets a key, defining `__proto__` as an own property instead of changing the prototype. */
function setProperty(obj: Obj, key: string, value: unknown) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { configurable: true, enumerable: true, value, writable: true });
  } else {
    obj[key] = value;
  }
}

function arrayToObject(source: unknown[]): Obj {
  const obj = createObject();
  for (let i = 0; i < source.length; ++i) {
    if (source[i] !== undefined) obj[i] = source[i];
  }
  return obj;
}

function combine(a: any, b: any, arrayLimit: number): any {
  if (isOverflow(a)) {
    const values = isArray(b) ? b : [b];
    let index = getMaxIndex(a);
    for (const value of values) a[++index] = value;
    overflow.set(a, index);
    return a;
  }

  const result = ([] as unknown[]).concat(a, b);
  if (result.length > arrayLimit) return markOverflow(arrayToObject(result), result.length - 1);
  return result;
}

function merge(target: any, source: any, options: Options): any {
  if (!source) return target;

  if (typeof source !== "object" && typeof source !== "function") {
    if (isArray(target)) {
      const nextIndex = target.length;
      if (nextIndex >= options.arrayLimit) {
        return markOverflow(arrayToObject(target.concat(source)), nextIndex);
      }
      target[nextIndex] = source;
    } else if (target && typeof target === "object") {
      if (isOverflow(target)) {
        const index = getMaxIndex(target) + 1;
        target[index] = source;
        overflow.set(target, index);
      } else {
        // qs' default strictMerge: a value merged into an object gives both.
        return [target, source];
      }
    } else {
      return [target, source];
    }
    return target;
  }

  if (!target || typeof target !== "object") {
    if (isOverflow(source)) {
      const result: Obj = createObject();
      result[0] = target;
      for (const key of Object.keys(source)) result[parseInt(key, 10) + 1] = source[key];
      return markOverflow(result, getMaxIndex(source) + 1);
    }
    const combined = [target].concat(source);
    if (combined.length > options.arrayLimit) {
      return markOverflow(arrayToObject(combined), combined.length - 1);
    }
    return combined;
  }

  let mergeTarget = target;
  if (isArray(target) && !isArray(source)) mergeTarget = arrayToObject(target);

  if (isArray(target) && isArray(source)) {
    source.forEach((item, i) => {
      if (has(target, i)) {
        const targetItem = target[i];
        if (targetItem && typeof targetItem === "object" && item && typeof item === "object") {
          target[i] = merge(targetItem, item, options);
        } else {
          target[target.length] = item;
        }
      } else {
        target[i] = item;
      }
    });
    if (target.length > options.arrayLimit) {
      return markOverflow(arrayToObject(target), target.length - 1);
    }
    return target;
  }

  return Object.keys(source).reduce((acc: Obj, key) => {
    const value = source[key];
    setProperty(acc, key, has(acc, key) ? merge(acc[key], value, options) : value);

    if (isOverflow(source) && !isOverflow(acc)) markOverflow(acc, getMaxIndex(source));
    if (isOverflow(acc)) {
      const index = parseInt(key, 10);
      if (String(index) === key && index >= 0 && index > getMaxIndex(acc)) overflow.set(acc, index);
    }
    return acc;
  }, mergeTarget);
}

/** Removes the holes of sparse arrays, everywhere in the result. */
function compact<T>(value: T): T {
  const queue: { obj: Obj; prop: string }[] = [{ obj: { o: value }, prop: "o" }];
  const seen = new WeakSet<object>();

  for (let i = 0; i < queue.length; ++i) {
    const { obj, prop } = queue[i];
    const current = obj[prop];
    for (const key of Object.keys(current)) {
      const child = current[key];
      if (typeof child === "object" && child !== null && !seen.has(child)) {
        queue.push({ obj: current, prop: key });
        seen.add(child);
      }
    }
  }

  while (queue.length > 1) {
    const { obj, prop } = queue.pop()!;
    const current = obj[prop];
    if (isArray(current)) obj[prop] = current.filter((item) => item !== undefined);
  }

  return value;
}

/** `qs`' decoder: `+` is a space, malformed escapes are kept. */
function decode(value: string, charset: string): string {
  const text = value.replace(/\+/g, " ");
  if (charset === "iso-8859-1") {
    return text.replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(parseInt(escape.slice(1), 16)));
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The `utf8=✓` sentinel, percent-encoded as UTF-8 and as ISO-8859-1 (`&#10003;`). */
const UTF8_SENTINEL = "utf8=%E2%9C%93";
const ISO_SENTINEL = "utf8=%26%2310003%3B";

/** Splits the string into keys with their decoded values, collecting repeated keys. */
function parseValues(str: string, options: Options): Obj {
  const obj: Obj = createObject();
  const cleanStr = str.replace(/%5B/gi, "[").replace(/%5D/gi, "]");
  const limit = options.parameterLimit === Infinity ? undefined : options.parameterLimit;
  const parts = cleanStr.split("&", limit);
  let charset = options.charset;
  let skipIndex = -1;

  if (options.charsetSentinel) {
    for (let i = 0; i < parts.length; ++i) {
      if (parts[i].indexOf("utf8=") === 0) {
        if (parts[i] === UTF8_SENTINEL) charset = "utf-8";
        else if (parts[i] === ISO_SENTINEL) charset = "iso-8859-1";
        skipIndex = i;
        break;
      }
    }
  }

  for (let i = 0; i < parts.length; ++i) {
    if (i === skipIndex) continue;
    const part = parts[i];
    const bracketEqualsPos = part.indexOf("]=");
    const pos = bracketEqualsPos === -1 ? part.indexOf("=") : bracketEqualsPos + 1;

    let key: string;
    let val: any;
    if (pos === -1) {
      key = decode(part, charset);
      val = "";
    } else {
      key = decode(part.slice(0, pos), charset);
      val = decode(part.slice(pos + 1), charset);
    }

    if (val && options.interpretNumericEntities && charset === "iso-8859-1") {
      val = String(val).replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    }

    if (has(obj, key)) obj[key] = combine(obj[key], val, options.arrayLimit);
    else obj[key] = val;
  }

  return obj;
}

/** Builds the nested value for one key's chain of segments, innermost first. */
function parseObject(chain: string[], val: any, options: Options): any {
  let leaf = val;

  for (let i = chain.length - 1; i >= 0; --i) {
    let obj: any;
    const root = chain[i];

    if (root === "[]") {
      obj = isOverflow(leaf) ? leaf : combine([], leaf, options.arrayLimit);
    } else {
      obj = createObject();
      const cleanRoot = root.charAt(0) === "[" && root.charAt(root.length - 1) === "]" ? root.slice(1, -1) : root;
      const index = parseInt(cleanRoot, 10);
      const isValidArrayIndex = !Number.isNaN(index) && root !== cleanRoot && String(index) === cleanRoot && index >= 0;

      if (isValidArrayIndex && index < options.arrayLimit) {
        obj = [];
        obj[index] = leaf;
      } else if (isValidArrayIndex) {
        obj[index] = leaf;
        markOverflow(obj, index);
      } else if (cleanRoot !== "__proto__") {
        obj[cleanRoot] = leaf;
      }
    }

    leaf = obj;
  }

  return leaf;
}

/** Splits `a[b][c]` into `["a", "[b]", "[c]"]`, up to `depth` levels. */
function splitKeyIntoSegments(key: string, options: Options): string[] {
  if (options.depth <= 0) return [key];

  const segments: string[] = [];
  const first = key.indexOf("[");
  const parent = first >= 0 ? key.slice(0, first) : key;
  if (parent) segments.push(parent);

  let open = first;
  let collected = 0;
  while (open >= 0 && collected < options.depth) {
    let level = 1;
    let i = open + 1;
    let close = -1;
    while (i < key.length && close < 0) {
      const code = key.charCodeAt(i);
      if (code === 0x5b) level += 1;
      else if (code === 0x5d && --level === 0) close = i;
      i += 1;
    }

    if (close < 0) {
      segments.push("[" + key.slice(open) + "]");
      return segments;
    }

    segments.push(key.slice(open, close + 1));
    collected += 1;
    open = key.indexOf("[", close + 1);
  }

  if (open >= 0) {
    if (options.strictDepth) {
      throw new RangeError(`Input depth exceeded depth option of ${options.depth} and strictDepth is true`);
    }
    segments.push("[" + key.slice(open) + "]");
  }

  return segments;
}

/**
 * Parses a query string or form body like `qs.parse` with
 * `allowPrototypes: true` and `plainObjects: true`.
 *
 * @throws RangeError when `strictDepth` is set and a key is deeper than `depth`.
 */
export function parseQs(str: string, opts: QsOptions = {}): Record<string, QsValue> {
  const options: Options = {
    arrayLimit: opts.arrayLimit ?? 20,
    charset: opts.charset ?? "utf-8",
    charsetSentinel: opts.charsetSentinel ?? false,
    depth: opts.depth ?? 5,
    interpretNumericEntities: opts.interpretNumericEntities ?? false,
    parameterLimit: opts.parameterLimit ?? 1000,
    strictDepth: opts.strictDepth ?? false,
  };

  if (!str) return createObject();

  const values = parseValues(str, options);
  let obj: Obj = createObject();
  for (const key of Object.keys(values)) {
    if (!key) continue;
    obj = merge(obj, parseObject(splitKeyIntoSegments(key, options), values[key], options), options);
  }

  return compact(obj);
}
