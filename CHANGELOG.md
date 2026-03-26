# Changelog

## Unreleased

- Broaden Laravel manual request inference for `has`, `filled`, `safe()->only([...])`, and `enum(...)`
- Infer Laravel responses through same-controller wrapper helpers and `findOrFail` / `firstOrFail` not-found paths
- Extend Laravel fixture coverage for richer request and response stabilization cases
- Improve Express request and response inference for variable-backed payloads, header access, and local helper wrappers
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
