# Changelog

All notable changes to Mira are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every package in the workspace is versioned in lockstep: `@gettersethya/mira-collection`,
`@gettersethya/mira-client`, `@gettersethya/mira`, `@gettersethya/mira-tanstack-adapter`
and `@gettersethya/mira-dashboard` always share one version.

Pre-releases are published under the `alpha` npm dist-tag and never move `latest`;
stable releases are published under `latest`. Entries before `0.1.0-alpha.33` are not
recorded here — that release is the first one published by CI.

## [Unreleased]

## [0.1.0-alpha.34] - 2026-10-27

### Changed

- **npm:** alpha releases now also move the `latest` dist-tag onto the new version. While the
  project is pre-1.0 the npm package page (which renders `latest`) shows the newest build, and
  `npm i @gettersethya/mira` resolves to it. Stable releases take `latest` back by publishing
  with `--tag latest`.
- **CI:** `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7` and
  `actions/download-artifact@v8`. `pnpm/action-setup` stays on v4 because v6 requires pnpm 11+.

## [0.1.0-alpha.33] - 2026-10-27

First release published by CI from a `v*` tag, with npm trusted publishing (OIDC) and
build provenance for all five packages.

### Added

- **Dashboard: Connect sheet.** Every collection page now has a `Connect` button that
  opens a tabbed sheet with ready-to-copy integration code for that collection.
  - `SDK` tab: install line, `createMiraClient(...).withCollections(collections)`, typed
    CRUD calls, the `@gettersethya/mira-tanstack-adapter` form, and a server-token variant.
    Auth collections lead with `register()` → `authWithPassword()` → `me()`.
  - `fetch` tab: wire-accurate HTTP calls, switchable between `fetch` and `curl`, including
    the JSON `FilterNode` used by the `filter` query parameter and multipart uploads when
    the collection has a file field.
  - `Types` tab: a generated `mira.generated.ts` with `BaseCollection` / `AuthCollection` /
    `ViewCollection` definitions, `PostsRecord` / `PostsCreate` / `PostsUpdate` aliases and a
    `collections` map, scoped to the current collection (plus its relation targets) or the
    whole schema, with copy and download.
  - The sheet state lives in the URL (`?connect=sdk|fetch|types`), and the base URL is
    editable and seeded from the configured `application_url`.
- **Dashboard: app settings.** `/settings` is split into `/settings/app` (editable
  configuration with editable/read-only/secret fields driven by the server) and
  `/settings/account`. The config API now returns `AppConfigResponse` and supports updates.
- **Dashboard: `InputGroup` primitive**, adopted across the record form fields.
- **Client:** `ApiFieldSchema` exposes the constraint annotations that `GET /api/_schema`
  already returned (`x-literal`, `x-maxSize`, `x-mimeTypes`, `minLength`, `maxLength`,
  `minimum`, `maximum`, `default`), so consumers can read field metadata without casts.
- **Release tooling:** tag-driven publishing. `pnpm release:alpha` / `pnpm release:stable`
  bump every manifest, commit and tag; `pnpm release:info <tag>` validates a tag against the
  manifests. `.github/workflows/publish.yml` verifies the tag, builds, typechecks, tests,
  packs with `pnpm pack` (which rewrites `workspace:*` to exact versions), publishes with
  `npm publish` in dependency order and creates a GitHub Release.

### Changed

- **Client:** `select` and `expand` keys are surfaced in the query option types.
- **Dashboard:** record forms, tables, sidebar, theme toggle and account menu were reworked
  on top of the new `InputGroup` primitive, and hidden values are stripped from exported and
  copied records.
- **Dashboard package:** `@gettersethya/mira-dashboard` now ships `ui/dist`, so the SPA is
  served from the published package instead of only from a local build.
- **Build:** each package has `clean-dist` and `check-exports` steps plus a dedicated
  `tsconfig.build.json`; pnpm is pinned through `packageManager`; the workspace root is
  `"type": "module"`.
- **CI:** least-privilege workflow permissions, no npm token (OIDC only), and a weekly
  Dependabot update for GitHub Actions.

### Fixed

- **Dashboard:** the Connect sheet was clamped to 75% width by the sheet primitive; it is now
  full-width on small screens and 896/1024 px on larger ones.
- **Dashboard:** snippets use unambiguous `<placeholder>` values instead of repeating the
  field name as the example value.
- **Example app:** `apps/example` declares `@types/node`, fixing `pnpm -r typecheck` on a
  clean install.

### Removed

- `scripts/bump-alpha.mjs` and `scripts/retag-latest.mjs`. Alpha releases no longer move the
  `latest` dist-tag; `latest` is reserved for stable releases.

### Security

- npm publishing uses short-lived OIDC credentials bound to the `npm_alpha` / `npm_stable`
  GitHub environments, with provenance attestations and no long-lived token in the repository.

[Unreleased]: https://github.com/GetterSethya/mira/compare/v0.1.0-alpha.34...HEAD
[0.1.0-alpha.34]: https://github.com/GetterSethya/mira/releases/tag/v0.1.0-alpha.34
[0.1.0-alpha.33]: https://github.com/GetterSethya/mira/releases/tag/v0.1.0-alpha.33
