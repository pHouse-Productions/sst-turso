# sst-turso

`TursoDatabase` is an SST (v3/v4) component for Turso (libSQL) databases. It's a Pulumi dynamic resource that calls the Turso Platform API directly, so it needs no provider plugin. It ships as a single source file with no build step: SST's bundler compiles it, and your `sst.config.ts` supplies the SST global types.

## Install

```sh
npm i github:pHouse-Productions/sst-turso#v0.1.0
```

## Use

```ts
// sst.config.ts
async run() {
  const { TursoDatabase } = await import("sst-turso"); // dynamic: SST rejects top-level imports
  const db = new TursoDatabase("Db", {
    organization: "my-org",
    name: `${$app.name}-${$app.stage}`,
    existing: $app.stage === "production", // adopt only, never create
  });
  new sst.aws.Nextjs("Web", { link: [db] });
}
```

At runtime, read `Resource.Db.url` and `Resource.Db.token` (`import { Resource } from "sst/resource"`).

| Option         | Default                         | Meaning                                                                                |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `organization` | required                        | Turso organization slug                                                                |
| `name`         | required                        | database name (lowercase letters, numbers, dashes; at most 64)                         |
| `group`        | `"default"`                     | existing Turso group                                                                   |
| `existing`     | `false`                         | only adopt an existing database: never create or delete it                             |
| `protect`      | `stage === "production"`        | Pulumi `protect` + `retainOnDelete`, plus Turso delete protection                      |
| `tokenVersion` | `1`                             | bump to mint a replacement database token (older tokens stay valid)                    |
| `apiToken`     | `TursoApiToken` SST secret      | Turso Platform API token                                                               |
| `dev`          | `{ url: "file:.local/dev.db" }` | what to link under `sst dev` (Turso is never called there); `false` uses Turso instead |

Without `existing`, creating the component looks the database up by name and adopts it if it already exists. A brand-new database is created, and deleted again when you remove its stage, unless it is protected.

## Setup

1. Mint a Platform API token with `turso auth api-tokens mint <app>-sst`.
2. Store it with `npx sst secret set TursoApiToken --stage <stage> < token-file`.
3. Run migrations with `npx sst shell --stage <stage> -- npx drizzle-kit migrate`, with `drizzle.config.ts` using `Resource.Db` when it is linked and falling back to env vars when it isn't.

## Adopting an app that already uses hand-wired Turso secrets

Roll out in two deploys, so each diff stays readable:

1. Add `TursoDatabase` (with `existing: true` for production), but keep the app on its old secrets. The deploy adopts the database, mints its token and turns on delete protection.
2. Switch the app to `link: [db]` and delete the old secrets. The token now exists, so this diff is clean.

The first deploy that dynamically imports a module shows a one-time `__provider` update on SST's own dynamic resources (zone lookups, KvKeys). Preview may also mark the DNS records as "replace", but that's only because the zone ID isn't known yet; the real deploy leaves them unchanged.

## Test

```sh
npm install && npm test
```
