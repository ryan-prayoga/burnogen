# brunogen

Generate Bruno collections from Laravel and Go API source code.

Pipeline:

```text
source code -> framework adapter -> normalized endpoint model -> openapi.yaml -> bruno collection
```

## Supported frameworks

- Laravel
- Go Fiber
- Go Gin
- Go Echo

## Install

From npm:

```bash
npm i -g brunogen
```

From GitHub Packages:

```bash
npm i -g @ryan-prayoga/brunogen --registry=https://npm.pkg.github.com
```

From GitHub:

```bash
npm i -g github:ryan-prayoga/burnogen-cli
```

## Commands

```bash
brunogen init
brunogen generate
brunogen watch
brunogen validate
brunogen doctor
```

## Quick start

Inside your API project:

```bash
brunogen init
brunogen generate
```

Default output:

- OpenAPI: `.brunogen/openapi.yaml`
- Bruno collection: `.brunogen/bruno`

## Example config

```json
{
  "version": 1,
  "framework": "auto",
  "inputRoot": ".",
  "output": {
    "openapiFile": ".brunogen/openapi.yaml",
    "brunoDir": ".brunogen/bruno"
  },
  "project": {
    "version": "1.0.0",
    "serverUrl": "{{baseUrl}}"
  },
  "environments": [
    {
      "name": "local",
      "variables": {
        "baseUrl": "http://localhost:3000",
        "authToken": ""
      }
    },
    {
      "name": "prod",
      "variables": {
        "baseUrl": "https://api.example.com",
        "authToken": ""
      }
    }
  ],
  "auth": {
    "default": "auto",
    "bearerTokenVar": "authToken",
    "basicUsernameVar": "username",
    "basicPasswordVar": "password",
    "apiKeyVar": "apiKey",
    "apiKeyName": "X-API-Key",
    "apiKeyLocation": "header"
  }
}
```

## Notes

- Partial generation is preferred over hard failure.
- OpenAPI is the normalized source of truth after scanning.
- Bruno is the output target, not the primary internal model.
- Current Go response/schema inference is heuristic and will improve over time.
- GitHub Packages publishes the scoped package `@ryan-prayoga/brunogen`.
