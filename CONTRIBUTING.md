# Contributing

Brunogen is still in early alpha territory. Prefer small, test-backed changes over broad rewrites.

## Local setup

```bash
npm install
npm run verify
```

The CI workflow mirrors `npm run verify` on pull requests and pushes to `main`.

## Expectations

- Preserve the core pipeline:
  `source code -> framework adapter -> normalized model -> OpenAPI -> Bruno`
- Prefer partial generation with warnings over hard failures
- Add fixture coverage for parser changes
- Update [docs/progress-notes.md](docs/progress-notes.md) if you change the config contract or normalized model
- Keep README claims honest

## Useful commands

```bash
npm run typecheck
npm test
npm run build
npm run demo:laravel
npm run demo:express
npm run demo:go
npm run verify
node dist/cli.js --help
```

## Canonical demo path

The Laravel fixture in `tests/fixtures/laravel` is the current happy path demo and should stay healthy.
If you intentionally change generated demo output, refresh the checked-in snapshots with `npm run demo:laravel`, `npm run demo:express`, and `npm run demo:go` as needed.
