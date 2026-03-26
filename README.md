# brunogen

[![CI](https://github.com/ryan-prayoga/brunogen/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ryan-prayoga/brunogen/actions/workflows/ci.yml)

Brunogen scans a Laravel, Express.js, or Go API codebase, normalizes what it finds into OpenAPI, and emits a Bruno collection you can try immediately.

Early public alpha. Laravel is the primary happy path today and now has materially richer request and response inference. Express.js and Go support exist, but remain experimental and heuristic.

CI runs `npm run verify` on pushes to `main` and on pull requests. That includes the Laravel golden snapshot test for the checked-in demo path.

## Install

```bash
npm i -g brunogen
```

## How It Works

```text
source code
  -> framework adapter
  -> normalized endpoint model
  -> openapi.yaml
  -> Bruno collection
```

OpenAPI is the internal source of truth after scanning. Bruno is the output target.

## Works Today

- Global CLI with `init`, `generate`, `watch`, `validate`, and `doctor`
- Laravel route scanning from `routes/*.php`
- Laravel route groups, prefixes, middleware-based auth hints, and `apiResource` expansion
- Laravel request schema inference from FormRequest rules, simple inline validation, and common manual request accessors such as `query`, `header`, typed accessors, `has`, `filled`, `safe()->only(...)`, and `enum(...)`
- Laravel response inference for direct arrays, `response()->json(...)`, `noContent()`, same-controller response helpers, `JsonResource`, `->additional(...)`, and common abort/error/not-found paths
- Bruno collection generation with environment files, baseline bearer/basic/api-key auth support, and native response `example {}` blocks
- OpenAPI generation and validation before export
- Express.js scanning in experimental mode for `express()`/`Router()`, mounted routers, basic handler imports, request access patterns, and variable-backed response inference
- Go Gin, Fiber, and Echo scanning in experimental mode with stronger direct JSON response inference

## Laravel-First Quickstart

The current canonical happy path is the minimal Laravel fixture in `tests/fixtures/laravel`.
Curated generated snapshots for that path live in [docs/demo/laravel-happy-path](docs/demo/laravel-happy-path/README.md).

```bash
npm install
npm run build

cd tests/fixtures/laravel
node ../../../dist/cli.js generate
```

To refresh the checked-in Laravel demo snapshots after an intentional output change:

```bash
npm run demo:laravel
```

Expected result:

```text
Generated 6 endpoints.
OpenAPI: .../tests/fixtures/laravel/.brunogen/openapi.yaml
Bruno: .../tests/fixtures/laravel/.brunogen/bruno
```

The normal installed flow is the same:

```bash
brunogen init
brunogen generate
```

Default output:

- `.brunogen/openapi.yaml`
- `.brunogen/bruno/`

## Express Quickstart

The Express fixture used by the test suite lives in `tests/fixtures/express`.
It covers mounted routers, route chains, middleware-based auth hints, request access patterns, and local response helper inference.
Curated generated snapshots for that path live in [docs/demo/express-happy-path](docs/demo/express-happy-path/README.md).

```bash
npm install
npm run build

cd tests/fixtures/express
node ../../../dist/cli.js generate
```

Expected result:

```text
Generated 3 endpoints.
OpenAPI: .../tests/fixtures/express/.brunogen/openapi.yaml
Bruno: .../tests/fixtures/express/.brunogen/bruno
```

## Supported Patterns

These are the current code shapes Brunogen reads most reliably.

### Laravel

Request inference is strongest when controllers or FormRequest classes use patterns like:

```php
$request->validate([...]);
$request->string('device_name');
$request->boolean('remember_me');
$request->array('scopes');
$request->query('page');
$request->header('TTOKEN');
$request->has('profile_photo');
$request->filled('nickname');
$request->safe()->only(['locale']);
$request->enum('role', UserRole::class);
```

Response inference is strongest when controllers use patterns like:

```php
return response()->json([...], 201);
return [...];
return ProjectResource::make($project)->additional([...]);
return $this->createdResponse($payload);
abort_if(!$enabled, 403, 'Forbidden');
Model::query()->findOrFail($id);
throw ValidationException::withMessages([...]);
```

### Express

Request inference is strongest when handlers use patterns like:

```ts
const { name, email, age = 18 } = req.body;
const page = req.query.page;
const { page: currentPage = 1 } = req.query;
const traceId = req.get("X-Trace-Id");
const auth = req.headers.authorization;
const trace = req.headers["x-trace-id"];
```

Response inference is strongest when handlers use patterns like:

```ts
return res.status(201).json({ message: "created", data: payload });
return res.json({ data: { id, name } });
return res.send("ok");
return res.sendStatus(204);
return sendCreated(res, payload);
return responseHelpers.sendCreated(res, payload);
```

## Example Input Project Shape

This is the minimal Laravel shape Brunogen currently handles well:

```text
app/
  Http/
    Controllers/
      SessionController.php
      UserController.php
    Requests/
      StoreUserRequest.php
routes/
  api.php
artisan
composer.json
```

## Example Output Tree

Generated from the Laravel fixture:

```text
.brunogen/
  openapi.yaml
  bruno/
    bruno.json
    environments/
      local.bru
    session/
      sessioncontrollercheck.bru
      sessioncontrollerstore.bru
    user/
      usercontrollerindex.bru
      usercontrollerindexgetapiprojects.bru
      usercontrollershow.bru
      usercontrollerstore.bru
```

The same snapshot is also checked into:

- [output-tree.txt](docs/demo/laravel-happy-path/output-tree.txt)
- [openapi-snippet.yaml](docs/demo/laravel-happy-path/openapi-snippet.yaml)
- [sessioncontrollercheck.bru](docs/demo/laravel-happy-path/bruno/session/sessioncontrollercheck.bru)
- [usercontrollerstore.bru](docs/demo/laravel-happy-path/bruno/user/usercontrollerstore.bru)

## Example Generated OpenAPI

Real snippet from the generated Laravel fixture output:

```yaml
openapi: 3.1.0
paths:
  /api/users:
    post:
      operationId: usercontrollerStore
      summary: UserController::store
      tags:
        - User
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  maxLength: 255
                  type: string
                email:
                  format: email
                  type: string
                age:
                  nullable: true
                  minimum: 18
                  type: integer
              required:
                - name
                - email
      responses:
        "201":
          description: Inferred JSON response
          content:
            application/json:
              schema:
                type: object
                properties:
                  message:
                    type: string
                  data:
                    type: object
                    properties:
                      id:
                        type: integer
                      name:
                        type: string
                      email:
                        type: string
              example:
                message: User created
                data:
                  id: 1
                  name: Jane Doe
                  email: jane@example.com
      security:
        - bearerAuth: []
```

## Example Generated Bruno Request

Real snippet from the generated Laravel fixture output:

```bru
meta {
  name: usercontrollerStore
  type: http
  seq: 4
  tags: [
    User
  ]
}

post {
  url: {{baseUrl}}/api/users
  body: json
  auth: bearer
}

headers {
  accept: application/json
  content-type: application/json
}

auth:bearer {
  token: {{authToken}}
}

body:json {
  {
    "name": "",
    "email": "user@example.com",
    "age": 1
  }
}

example {
  name: "201 Response"
  description: "Inferred JSON response"

  request: {
    url: {{baseUrl}}/api/users
    method: post
    mode: json
    headers: {
      accept: application/json
      content-type: application/json
    }

    body:json: {
      {
        "name": "",
        "email": "user@example.com",
        "age": 1
      }
    }
  }

  response: {
    headers: {
      Content-Type: application/json
    }

    status: {
      code: 201
      text: Created
    }

    body: {
      type: json
      content: '''
        {
          "message": "User created",
          "data": {
            "id": 1,
            "name": "Jane Doe",
            "email": "jane@example.com"
          }
        }
      '''
    }
  }
}
```

## Example Config

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

## Support Matrix

| Area | Status | Notes |
| --- | --- | --- |
| Laravel route scanning | Supported | Reads `routes/*.php` declarations |
| Laravel route groups and prefixes | Supported | Handles common `prefix`, `middleware`, and grouped routes |
| Laravel `apiResource` expansion | Supported | Common REST actions are expanded |
| Laravel FormRequest inference | Partial | `rules()` arrays are supported; complex dynamic rules are not |
| Laravel manual request inference | Strong partial | Common `query`, `header`, `input`, typed accessors, `has`, `filled`, `only([...])`, `safe()->only([...])`, and `enum(...)` patterns are inferred |
| Laravel inline validation inference | Partial | Simple `$request->validate()` and `Validator::make()` arrays |
| Auth inference | Partial | Middleware and OpenAPI security are inferred heuristically |
| OpenAPI generation | Supported | OpenAPI is the normalized intermediate output |
| Bruno export | Supported | Collection, requests, environments, baseline auth blocks, and response `example {}` blocks |
| Express route scanning | Experimental | Handles `express()` / `Router()`, `use()` mounts, and `route()` chains |
| Express handler inference | Experimental | Heuristic request and response inference from straightforward handlers and local response helpers |
| Go Fiber scanning | Experimental | Route and request inference are heuristic |
| Go Gin scanning | Experimental | Route and request inference are heuristic |
| Go Echo scanning | Experimental | Route and request inference are heuristic |
| Go request schema inference | Experimental | Works for straightforward bind/body-parser patterns |
| Laravel response inference | Strong partial | Covers direct arrays, `response()->json(...)`, `noContent()`, same-controller wrapper helpers, `JsonResource`, `->additional(...)`, and common abort/error/not-found paths |
| Express response inference | Partial | Straightforward `res.json()`, `res.send()`, `res.status(...).json()`, `sendStatus()`, and local helper wrappers |
| Go response inference | Partial | Covers common direct JSON responses plus existing helper-based patterns, but remains heuristic |
| Watch mode | Supported | Regenerates on `.php`, `.go`, `.js`, `.cjs`, `.mjs`, and `.ts` changes |

## Known Limitations

- This is not production-hardened. It is an early public alpha.
- Laravel parsing is regex-driven, not full AST analysis.
- Express parsing is also regex-driven, not full AST analysis.
- Complex dynamic route declarations may be skipped with warnings.
- Complex Express router factories, metaprogrammed middleware, and indirect exports may be skipped with warnings.
- Complex Laravel validation rules, custom rule objects, and conditional rules are not fully inferred.
- Laravel response inference is still best-effort around cross-class service wrappers, custom responder classes, and highly dynamic resource composition.
- Express request and response inference currently targets straightforward `req.body` / `req.query` / `req.headers` access and local `res.*()` helper wrappers.
- Go support is intentionally labeled experimental.
- Go route parsing can miss unusual middleware signatures or custom router abstractions.
- Go response schemas are still best-effort around indirect helpers, nested wrappers, and custom response builders.
- Generated Bruno auth is baseline setup, not a complete auth flow engine.

## Roadmap

- Stabilize the Laravel path as the default demoable experience
- Broaden and harden the Express adapter without losing the current lightweight scanner model
- Improve Laravel and Go response inference without breaking the current OpenAPI-first pipeline
- Broaden Laravel support for cross-class wrappers and more reusable response helper patterns
- Reduce Go false positives and document supported code patterns more precisely
- Add more canonical fixtures before broadening framework claims

## Release Hygiene

Useful checks before tagging:

```bash
npm run verify
```

Related docs:

- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/release-checklist.md](docs/release-checklist.md)

## npm Publishing

This repository publishes to npm through `.github/workflows/publish-npm.yml`.
It is set up for npm Trusted Publishing with GitHub Actions OIDC, so it does not need an `NPM_TOKEN`.

Recommended release flow:

1. Update `package.json` version and changelog.
2. Push the commit to `main`.
3. Create or publish a GitHub Release for the version tag.
4. The `Publish To npm` workflow will run automatically and publish the package to npm.

Notes:

- The workflow uses the GitHub Actions environment `npm`. If you want approvals or branch restrictions, configure that environment in GitHub repository settings.
- Stable releases publish to the npm `latest` dist-tag. Prereleases publish to `next`.
- If you are setting up Trusted Publishing for a different repository, align the npm Trusted Publisher settings with that repository's owner, repository, workflow filename, and environment name.
