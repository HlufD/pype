import { statSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";

/**
 * A template engine, the signature Express uses: renders the file at `path`
 * with `options` and calls back with the HTML.
 */
export type Engine = (
  path: string,
  options: Record<string, any>,
  callback: (err: Error | null, html?: string) => void,
) => void;

/** Options for {@link View}. */
export interface ViewOptions {
  /** The `"view engine"` setting, used when `name` has no extension. */
  defaultEngine?: string;
  /** The `"views"` setting: a directory or a list searched in order. */
  root: string | string[];
  /** Registered engines by extension, e.g. `{ ".ejs": renderFile }`. Filled in when an engine is loaded. */
  engines: Record<string, Engine>;
}

/**
 * A template file, found and rendered the way Express's `View` does, so
 * `app.set("view", CustomView)` works with the same interface.
 *
 * - Without an extension, `name` gets the default engine's.
 * - The engine for the extension is the registered one, or the npm module
 *   named after it (`require("pug").__express`).
 * - Each root is searched for `name` and then `name/index.<ext>`.
 */
export class View {
  /** The name as passed to `render()`. */
  name: string;
  /** Extension with a dot, e.g. `.ejs`. */
  ext: string;
  defaultEngine?: string;
  root: string | string[];
  engine: Engine;
  /** Full path of the template, `undefined` when it wasn't found. */
  path: string | undefined;

  /**
   * @throws When `name` has no extension and there is no default engine, or
   * the module named after the extension doesn't provide `__express`.
   */
  constructor(name: string, options: ViewOptions) {
    this.name = name;
    this.root = options.root;
    this.defaultEngine = options.defaultEngine;
    this.ext = extname(name);

    if (!this.ext && !this.defaultEngine) {
      throw new Error("No default engine was specified and no extension was provided.");
    }

    let fileName = name;
    if (!this.ext) {
      this.ext = this.defaultEngine!.startsWith(".") ? this.defaultEngine! : `.${this.defaultEngine}`;
      fileName += this.ext;
    }

    if (!options.engines[this.ext]) {
      const module = this.ext.slice(1);
      const engine = require(module).__express;
      if (typeof engine !== "function") {
        throw new Error(`Module "${module}" does not provide a view engine.`);
      }
      options.engines[this.ext] = engine;
    }

    this.engine = options.engines[this.ext];
    this.path = this.lookup(fileName);
  }

  /** Searches each root for `name`, see {@link View.resolve}. */
  lookup(name: string): string | undefined {
    for (const root of ([] as string[]).concat(this.root)) {
      const location = resolve(root, name);
      const path = this.resolve(dirname(location), basename(location));
      if (path) return path;
    }
    return undefined;
  }

  /** `dir/file`, or `dir/<file without extension>/index<ext>`, whichever is a file. */
  resolve(dir: string, file: string): string | undefined {
    const direct = join(dir, file);
    if (isFile(direct)) return direct;

    const index = join(dir, basename(file, this.ext), `index${this.ext}`);
    if (isFile(index)) return index;

    return undefined;
  }

  /** Renders with the engine. The callback always runs asynchronously, like Express. */
  render(options: Record<string, any>, callback: (err: Error | null, html?: string) => void) {
    let sync = true;
    this.engine(this.path!, options, function (this: unknown, ...args) {
      if (!sync) return callback.apply(this, args as [Error | null, string?]);
      process.nextTick(() => callback.apply(this, args as [Error | null, string?]));
    });
    sync = false;
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
