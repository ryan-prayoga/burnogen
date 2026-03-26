# Laravel Happy Path Demo

This folder captures the current canonical Brunogen demo path.

Source fixture:

- `tests/fixtures/laravel`

Command used:

```bash
cd tests/fixtures/laravel
brunogen init
brunogen generate
```

Expected result:

```text
Generated 6 endpoints.
OpenAPI: .../tests/fixtures/laravel/.brunogen/openapi.yaml
Bruno: .../tests/fixtures/laravel/.brunogen/bruno
```

Files in this folder are curated snapshots from that generated output:

- `output-tree.txt`
- `openapi-snippet.yaml`
- `bruno/session/sessioncontrollercheck.bru`
- `bruno/user/usercontrollerstore.bru`
