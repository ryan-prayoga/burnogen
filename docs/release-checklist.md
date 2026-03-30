# Release Checklist

## Before tagging

- Confirm package metadata matches the repository and CLI command
- Run `npm run verify`
- Run the Laravel fixture demo:
  `cd tests/fixtures/laravel && node ../../../dist/cli.js generate`
- If output changed intentionally, refresh and review the checked-in demo snapshots:
  `npm run demo:laravel`
  `npm run demo:express`
  `npm run demo:go`
- Review README for accuracy against current behavior
- Review support matrix and known limitations for honesty
- Confirm `CHANGELOG.md` reflects the release scope

## GitHub release

- Tag the release
- Publish release notes from `CHANGELOG.md`
- Check that the `Publish To npm` workflow succeeds for the release tag

## After release

- Install from npm in a clean shell:
  `npm i -g brunogen`
- Run `brunogen --help`
- Smoke test `brunogen generate` against the Laravel fixture
- Confirm the npm `latest` dist-tag points to the new version
