# Express Happy Path Demo

This folder captures the current checked-in Express demo path.

Source fixture:

- `tests/fixtures/express`

Command used:

```bash
cd tests/fixtures/express
node ../../../dist/cli.js generate
```

Expected result:

```text
Generated 3 endpoints.
OpenAPI: .../tests/fixtures/express/.brunogen/openapi.yaml
Bruno: .../tests/fixtures/express/.brunogen/bruno
```

Files in this folder are curated snapshots from that generated output:

- `output-tree.txt`
- `openapi-snippet.yaml`
- `bruno/api/createuser.bru`
