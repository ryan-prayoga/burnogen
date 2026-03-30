# Changelog

## Unreleased

## v0.4.1
*Released: 2026-03-30*

- Align `doctor` path resolution with config-root behavior used by `generate`, including explicit `--config` handling
- Add regression coverage for `doctor` with explicit config location resolution
- Add Express and Go demo refresh scripts (`demo:express`, `demo:go`) and update release/contributor docs accordingly
- Refresh Go demo snapshot coverage with a dedicated test and synced fixture snippets
- Sync README/demo quickstart endpoint counts and config contract docs with current generated output

## v0.4.0
*Released: 2026-03-27*

- Expand Express route inference for nested mounts, named router exports, chained routes, and broader auth middleware hints
- Improve Express request/response inference for direct body access, typed route syntax, inline and nested Joi-backed schema hints, common helper wrappers, and richer demo coverage
- Rework Go route scanning to follow grouped registrations across helper functions and broaden Gin/Fiber/Echo fixture coverage
- Infer more Go request constraints from `binding` / `validate` tags and handle more response patterns such as `Status(...).JSON(...)`, `AbortWithStatusJSON(...)`, and `SendStatus(...)`
- Add configurable auth middleware pattern hints plus clearer Go and Express warnings when a middleware looks security-related but is not recognized, including `doctor` visibility
- Add stronger `doctor` output for Express and Go projects plus extra OpenAPI consistency checks in `brunogen validate`

## v0.3.1

- Refresh the public README with framework-specific visual previews for Laravel, Express, and Go
- Add a checked-in Go happy-path demo snapshot
- Clarify quickstart and demo callouts so the first-run path is easier to understand from GitHub and npm

## v0.3.0

- Broaden Laravel manual request inference for `has`, `filled`, `safe()->only([...])`, and `enum(...)`
- Infer Laravel responses through same-controller wrapper helpers and `findOrFail` / `firstOrFail` not-found paths
- Extend Laravel fixture coverage for richer request and response stabilization cases
- Improve Express request and response inference for variable-backed payloads, header access, and local helper wrappers
- Infer typed Express request schemas from common default-value patterns
- Add and lock an Express happy-path demo snapshot
- Improve Go response inference for direct Gin and Echo JSON responses
- Add explicit supported-pattern guidance for Laravel and Express in the README

## v0.2.0

- Add Express.js project support with mounted router, request, and response inference
- Expand Laravel request inference for manual query, header, and typed request access patterns
- Expand Laravel response inference for variable-backed JSON payloads, `JsonResource`, `->additional(...)`, and common abort/error paths
- Export Bruno response `example {}` blocks from generated OpenAPI response examples
- Refresh Laravel demo snapshots and README to reflect the richer generated output

## v0.1.1

- Publish `brunogen` from the `ryan-prayoga/brunogen` repository metadata on npm
- Add npm Trusted Publisher workflow for GitHub Actions OIDC
- Publish prereleases to the npm `next` dist-tag
- Expand documentation for Express.js support and npm publishing

## v0.1.0-alpha

First public alpha positioning for Brunogen.

- Laravel-first CLI flow documented and hardened
- OpenAPI to Bruno pipeline documented with real generated examples
- Laravel fixture established as the canonical happy path
- Support matrix and concrete known limitations documented
- Release hygiene added: `verify` script, contributing guide, and release checklist
- Go support documented as experimental where inference is still heuristic
