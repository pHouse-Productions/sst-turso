# sst-turso

`TursoDatabase` is an SST (v3/v4) component for Turso (libSQL) databases. It's a Pulumi dynamic resource that calls the Turso Platform API directly, so it needs no provider plugin. It ships as a single source file with no build step: SST's bundler compiles it, and your `sst.config.ts` supplies the SST global types.

## Install

```sh
npm i github:pHouse-Productions/sst-turso#v0.2.0 # a regular dependency: the runtime helper ships in your server bundle
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

At runtime, connect with the helper. It returns the linked `Resource.Db` when there is one (deployed stages, `sst dev`, `sst shell`), and otherwise falls back to `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`, for plain local dev, scripts and tests:

```ts
import { tursoConnection } from "sst-turso/runtime";

const { url, authToken } = tursoConnection(); // or tursoConnection("OtherDb", { urlEnv: "OTHER_URL" })
const client = createClient({ url: url!, authToken });
```

Use it in `drizzle.config.ts` as well, so `npx sst shell --stage <stage> -- npx drizzle-kit migrate` targets the linked database. The helper is plain JavaScript, so no `transpilePackages` setting is needed.

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

1. Once, for all your apps: mint one Platform API token, scoped to the group your databases live in, and keep it in your password manager. Turso shows it only once.

   ```sh
   turso auth api-tokens mint sst --group default \
     --scope read --scope db:create --scope db:delete --scope db:configure --scope db:mint-token
   ```

   On macOS you can keep it in the Keychain instead. Store it with `security add-generic-password -s turso-sst-api-token -a "$USER" -w` (it prompts for the value).

2. Per app and stage: store that same token in the app's `TursoApiToken` secret. Don't mint a new token per app. Each one would have the same reach and would be one more thing to revoke.

   ```sh
   security find-generic-password -s turso-sst-api-token -w \
     | npx sst secret set TursoApiToken --stage <stage>
   ```

   Without the Keychain, use `npx sst secret set TursoApiToken --stage <stage> < token-file`.

3. Run migrations with `npx sst shell --stage <stage> -- npx drizzle-kit migrate`, with `drizzle.config.ts` reading `tursoConnection()`.

## Adopting an app that already uses hand-wired Turso secrets

Roll out in two deploys, so each diff stays readable:

1. Add `TursoDatabase` (with `existing: true` for production), but keep the app on its old secrets. The deploy adopts the database, mints its token and turns on delete protection.
2. Switch the app to `link: [db]` and delete the old secrets. The token now exists, so this diff is clean.

The first deploy that dynamically imports a module shows a one-time `__provider` update on SST's own dynamic resources (zone lookups, KvKeys). Preview may also mark the DNS records as "replace", but that's only because the zone ID isn't known yet; the real deploy leaves them unchanged.

## Reading diffs

Any change to a database's inputs, such as a new `TursoApiToken` value or a `tokenVersion` bump, makes its preview list every linked function as deleted. Pulumi can't run a dynamic resource's update during preview, so it marks all the database's outputs, including the database token, as unknown. SST only builds a function once all its linked values are known, so it skips building them, and the diff reads the skipped functions as deletions. The real deploy runs the update, which returns the token (unchanged unless `tokenVersion` changed), and the functions build normally. If the only planned change is to the database itself, those deletions are preview-only. Check `detailedDiff` with `sst diff --json` if in doubt.

## Test

```sh
npm install && npm test
```
