# Go Happy Path Demo

This folder captures the current checked-in Go demo path using the Gin fixture.

Source fixture:

- `tests/fixtures/gin`

Command used:

```bash
cd tests/fixtures/gin
brunogen init
brunogen generate
```

Expected result:

```text
Generated 2 endpoints.
OpenAPI: .../tests/fixtures/gin/.brunogen/openapi.yaml
Bruno: .../tests/fixtures/gin/.brunogen/bruno
```

Files in this folder are curated snapshots from that generated output:

- `output-tree.txt`
- `openapi-snippet.yaml`
- `bruno/api/createuser.bru`
