# Pype

[![CI](https://github.com/HlufD/pipe-router/actions/workflows/ci.yml/badge.svg)](https://github.com/HlufD/pipe-router/actions/workflows/ci.yml)

Pype is an Express 5 compatible web framework for Node.js, written in
TypeScript, with a radix tree router and no runtime dependencies. This
repository is a monorepo containing the framework and related packages.

## Packages

| Package | npm | Description |
| ------- | --- | ----------- |
| [`packages/core`](packages/core) | [`pyper-web`](https://www.npmjs.com/package/pyper-web) | The web framework |
| [`packages/di`](packages/di) | `pyper-di` (not published yet) | Dependency injection container, not started |

To use the framework, see the [`pyper-web` README](packages/core/README.md).

## Repository layout

```
packages/
  core/               pyper-web: src/, tests/, bench/
  di/                 pyper-di: empty placeholder
docs/
  ARCHITECTURE.md     how the framework is built, and why
  SECURITY.md         reporting vulnerabilities
tsconfig.base.json    compiler options shared by all packages
package.json          npm workspaces root (private)
```

## Development

Requires Node.js 22 or later. Install once from the root; npm workspaces link
the packages together:

```sh
npm install
```

Run commands for every package from the root:

```sh
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Or for one package with `-w`:

```sh
npm test -w pyper-web
npm run bench -w pyper-web
npm run test:fuzz -w pyper-web
```

### Adding a package

1. Create `packages/<name>/` with its own `package.json`, `src/` and
   `tests/`.
2. Extend the shared compiler options in its `tsconfig.json`:
   `{ "extends": "../../tsconfig.base.json" }`.
3. To depend on another package in this repo, add it to `dependencies` by its
   npm name (for example `"pyper-web": "^0.1.0"`) and run `npm install`; npm
   links the local copy.
4. Give it `build`, `typecheck` and `test` scripts so the root commands and
   CI pick it up.

## Publishing

Each package is published on its own from its folder or with `-w`:

```sh
npm publish -w pyper-web
```

`prepublishOnly` runs the package's type check, tests and build first.

## License

[ISC](LICENSE)
