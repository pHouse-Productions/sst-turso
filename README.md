# sst-turso

`TursoDatabase` is an SST (v3/v4) component for Turso (libSQL) databases. It's a Pulumi dynamic resource that calls the Turso Platform API directly, so it needs no provider plugin. It ships as a single source file with no build step: SST's bundler compiles it, and your `sst.config.ts` supplies the SST global types.

## Install

```sh
npm i github:pHouse-Productions/sst-turso#v0.4.0 # a regular dependency: the runtime helper ships in your server bundle
```

## Use

```ts
// sst.config.ts
async run() {
  const { TursoDatabase } = await import("sst-turso"); // dynamic: SST rejects top-level imports
  const db = new TursoDatabase("Db", {
    organization: "my-org",
    name: `${$app.name}-${$app.stage}`,
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

| Option         | Default                         | Meaning                                                                                 |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `organization` | required                        | Turso organization slug                                                                 |
| `name`         | required                        | database name (lowercase letters, numbers, dashes; at most 64)                          |
| `group`        | `"default"`                     | existing Turso group                                                                    |
| `existing`     | `false`                         | rarely needed: fail instead of creating if the database is missing, and never delete it |
| `protect`      | `stage === "production"`        | Pulumi `protect` + `retainOnDelete`, plus Turso delete protection                       |
| `tokenVersion` | `1`                             | bump to mint a replacement database token (older tokens stay valid)                     |
| `apiToken`     | `TursoApiToken` SST secret      | Turso Platform API token                                                                |
| `dev`          | `{ url: "file:.local/dev.db" }` | what to link under `sst dev` (Turso is never called there); `false` uses Turso instead  |

Without `existing`, creating the component looks the database up by name and adopts it if it already exists. A brand-new database is created, and deleted again when you remove its stage, unless it is protected.

## Kysely

`sst-turso/kysely` gives every app the same tested Kysely ↔ libSQL setup. Install the optional peers first: `npm i kysely @libsql/client`.

```ts
import { createTursoKysely } from "sst-turso/kysely";
import type { DB } from "./db.generated";

export const db = createTursoKysely<DB>({
  production: isProductionStage, // your own flag: require a libsql:// URL and token, or throw
  // link: "Db", urlEnv/tokenEnv/env: same as tursoConnection(); plugins: optional Kysely plugins
});
```

It reads `tursoConnection()`. Remote URLs use `@libsql/client/web`. `file:`, `:memory:` and loopback URLs (`turso dev`) use the native `@libsql/client`, which is required lazily, so deployed code never loads it. With `production: true`, anything but a `libsql://` URL with a token throws.

For your own client, use the dialect directly: `new Kysely<DB>({ dialect: new LibsqlDialect(client) })`. `db.destroy()` closes the client by default, since the dialect usually owns it. Pass `{ closeOnDestroy: false }` when something else shares the client.

**Why not `@libsql/kysely-libsql`?** It imports the default `@libsql/client` entry, which loads a native SQLite binary that isn't in the Lambda (OpenNext) bundle, and it pins `@libsql/client` to `^0.8`. This module statically imports only `@libsql/client/web`, a pure HTTP client, and a test enforces that. The `sst-turso` component and `sst-turso/runtime` never import Kysely or libSQL.

Transactions and savepoints work as usual:

```ts
await db.transaction().execute(async (trx) => { /* commit, or roll back on throw */ });

const trx = await db.startTransaction().execute();
const sp = await trx.savepoint("before_import").execute();
try {
  await sp.insertInto("item").values(rows).execute();
  await sp.releaseSavepoint("before_import").execute();
} catch {
  await sp.rollbackToSavepoint("before_import").execute(); // keeps the outer work
}
await trx.commit().execute();
```

Savepoint names must match `[A-Za-z_][A-Za-z0-9_]*` (up to 64 characters). Streaming isn't supported.

### Booleans and Dates

SQLite has no boolean or date types, so by default you get back what libSQL stores: `1`/`0`, and a `Date` you wrote comes back as epoch milliseconds.

**Recommended:** use SQLite-native columns (`integer not null check (col in (0, 1))` for booleans; `text` holding exact `toISOString()` values for times, which matches Better Auth's SQLite format, or `integer` epoch milliseconds) and convert explicitly in your app's store layer, so the database's values and your types stay in plain sight.

`convertDeclaredTypes: true` (on `createTursoKysely` or `LibsqlDialect`) is an optional alternative, not the recommended pattern. It writes records as-is and gives back real booleans and Dates, based on the column types the schema declares:

- **Writes:** `Date` parameters bind as UTC ISO-8601 text (`2026-11-18T09:30:00.000Z`), the format Better Auth uses. Booleans already bind as `1`/`0`.
- **Reads:** columns declared `boolean` or `bool` map `0`/`1` to `false`/`true`. Columns declared `timestamp`, `datetime` or `date` map ISO text (SQLite's zone-less `2026-11-18 09:30:00` is read as UTC) or epoch milliseconds to a `Date`. Type names are case-insensitive, and a length suffix such as `timestamp(3)` is fine. `null` stays `null`.

This works from the column types your schema declares, which libSQL reports with each result (`ResultSet.columnTypes`, Hrana `decltype`). So the schema must declare them: `createdAt datetime`, not `createdAt text`. Values that only come from expressions, such as `count(*)`, `max(createdAt)` or `cast(...)`, have no declared type and pass through unchanged. Selecting a column directly, even under an alias, keeps its type. The option checks once, on the first query, that the server reports declared types (one extra `select` per client), and fails clearly if it doesn't, rather than silently doing nothing. Local `file:` databases and `sqld`/`turso dev` report them (tested with sqld 0.24), and Turso runs sqld.

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

1. Add `TursoDatabase` with the database's current name, but keep the app on its old secrets. The deploy finds the database by name and adopts it, mints its token and turns on delete protection. No flag is needed.
2. Switch the app to `link: [db]` and delete the old secrets. The token now exists, so this diff is clean.

The first deploy that dynamically imports a module shows a one-time `__provider` update on SST's own dynamic resources (zone lookups, KvKeys). Preview may also mark the DNS records as "replace", but that's only because the zone ID isn't known yet; the real deploy leaves them unchanged.

## Reading diffs

Any change to a database's inputs, such as a new `TursoApiToken` value or a `tokenVersion` bump, makes its preview list every linked function as deleted. Pulumi can't run a dynamic resource's update during preview, so it marks all the database's outputs, including the database token, as unknown. SST only builds a function once all its linked values are known, so it skips building them, and the diff reads the skipped functions as deletions. The real deploy runs the update, which returns the token (unchanged unless `tokenVersion` changed), and the functions build normally. If the only planned change is to the database itself, those deletions are preview-only. Check `detailedDiff` with `sst diff --json` if in doubt.

## Test

```sh
npm install && npm test
```
