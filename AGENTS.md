# Repository Guidelines

## Project Structure & Module Organization

CinePro Core is an OMSS-compliant streaming backend built on `@omss/framework`. The entry point (`src/server.ts`) bootstraps an `OMSSServer` instance; providers are auto-discovered from `src/providers/` by directory convention — no manual registration needed.

**58 providers** live under `src/providers/<name>/`, each with `<name>.ts` (extending `BaseProvider`), `<name>.types.ts`, optional `decrypt.ts`/`encrypt.ts`, and a `test.ts` for standalone verification.

**14 embed resolvers** in `src/utils/embeds/` (filemoon, voe, dood, streamtape, streamwish, dropload, supervideo, ridoo, turbovid, vidnest, zunime, animetsu, animekai, myanime) are shared across providers that resolve embed URLs. A barrel `index.ts` exports all resolvers and their types.

**Shared utilities** in `src/utils/`: `scraping.ts` (HTTP/HTML helpers), `crypto.ts` (decryption primitives), `ua.ts` (user-agent pool), `jsunpack.ts` (JS unpacker). `src/thirdPartyProxies.ts` and `src/streamPatterns.ts` configure framework proxy-removal and stream URL matching.

## Build, Test, and Development Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start dev server with hot-reload (`tsx watch`) |
| `npm run build` | TypeScript compile (`tsc`) to `dist/` |
| `npm start` | Build then run production server |
| `npm run format` | Format `src/` with Prettier |
| `npx tsx src/providers/<name>/test.ts` | Test an individual provider |

Set `INTERNAL_DEBUG=true` in `.env` to include non-playable sources and diagnostics.

CI (`ci.yml`) runs: `npm audit` → `npx prettier --check src` → `npm run build`.

## Coding Style & Naming Conventions

**Prettier** enforces formatting: 4-space indent, single quotes, no trailing commas, 80-char print width, semicolons required. **TypeScript strict mode** is enabled — no `any` or `@ts-ignore`.

Naming: `PascalCase` classes, `camelCase` functions/variables, `UPPER_SNAKE_CASE` constants, kebab-case files with `.types.ts` suffix for types. Use `this.console.log()` (not bare `console.log()`). All streaming URLs must go through `this.createProxyUrl()`. Use `Promise.all()` for concurrent requests.

## Commit & Pull Request Guidelines

Conventional commits format observed in history:

```
feat: add fshare provider
fix: peachify
chore: update deps
chore: sunset 02
```

Types used: `feat`, `fix`, `chore`, `docs`, `refactor`. Branch naming follows `feat/`, `fix/` prefixes. PRs target `main` (or `dev` for in-progress work) and require CI to pass. PR template exists at `.github/PULL_REQUEST_TEMPLATE.md`.

## Provider Development

Providers follow a two-tier architecture:

1. **Direct stream sources** — return playable stream URLs directly from the provider's own servers.
2. **Embed-resolving sources** — fetch an embed page, then delegate extraction to one of the shared resolvers in `src/utils/embeds/`.

When adding a new provider, extend `BaseProvider`, declare `capabilities`, implement `getMovieSources()` and/or `getTVSources()`, and return the standard `ProviderResult` shape (`{ sources, subtitles, diagnostics }`). Use `emptyResult(diagnostics)` to return a clean empty response with diagnostic entries on failure. Every streaming URL must be wrapped with `this.createProxyUrl()`. Every provider directory must include a `test.ts` file for standalone verification. See `.github/CONTRIBUTING.md` for the full checklist.
