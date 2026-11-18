import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { CamelCasePlugin, type Kysely, sql } from "kysely";
import {
  createTursoKysely,
  isLocalLibsqlUrl,
  LibsqlDialect,
} from "../kysely.js";

// Stand-in for the pure HTTP client: remote URLs must never touch the network
// in tests, and the spy shows which entry each URL picks.
const webClient = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
}));
const createWebClient = vi.hoisted(() => vi.fn(() => webClient));
vi.mock("@libsql/client/web", () => ({ createClient: createWebClient }));

// kysely.js requires the native entry lazily through Node's CJS loader; spy on
// that shared module object.
const native: { createClient: typeof createClient } = createRequire(
  import.meta.url,
)("@libsql/client");

interface DB {
  item: { id: number | null; name: string; qty: number };
}

let dir: string;
let url: string;
let db: Kysely<DB>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sst-turso-kysely-"));
  url = `file:${join(dir, "test.db")}`;
  db = createTursoKysely<DB>({ env: { TURSO_DATABASE_URL: url } });
  await db.schema
    .createTable("item")
    .addColumn("id", "integer", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull().unique())
    .addColumn("qty", "integer", (c) => c.notNull())
    .execute();
});

afterEach(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  createWebClient.mockClear();
});

const names = async () =>
  (await db.selectFrom("item").select("name").orderBy("name").execute()).map(
    (r) => r.name,
  );

describe("LibsqlDialect", () => {
  it("runs CRUD with returning, affected rows and insert ids", async () => {
    const inserted = await db
      .insertInto("item")
      .values({ name: "a", qty: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(inserted).toEqual({ id: 1, name: "a", qty: 1 });
    expect(Object.getPrototypeOf(inserted)).toBe(Object.prototype);

    const plain = await db
      .insertInto("item")
      .values({ name: "b", qty: 2 })
      .executeTakeFirstOrThrow();
    expect(plain.insertId).toBe(2n);

    const updated = await db
      .updateTable("item")
      .set((eb) => ({ qty: eb("qty", "+", 10) }))
      .executeTakeFirstOrThrow();
    expect(updated.numUpdatedRows).toBe(2n);

    const deleted = await db
      .deleteFrom("item")
      .where("name", "=", "a")
      .returning(["name", "qty"])
      .execute();
    expect(deleted).toEqual([{ name: "a", qty: 11 }]);
    expect(
      await db.selectFrom("item").selectAll().where("id", "=", 2).execute(),
    ).toEqual([{ id: 2, name: "b", qty: 12 }]);
  });

  it("commits and rolls back transactions", async () => {
    await db.transaction().execute(async (trx) => {
      expect(trx.isTransaction).toBe(true);
      await trx.insertInto("item").values({ name: "kept", qty: 1 }).execute();
    });
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("item").values({ name: "lost", qty: 1 }).execute();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.isTransaction).toBe(false);
    expect(await names()).toEqual(["kept"]);
  });

  it("supports controlled transactions with savepoints", async () => {
    const trx = await db.startTransaction().execute();
    expect(trx.isTransaction).toBe(true);
    await trx.insertInto("item").values({ name: "outer", qty: 1 }).execute();

    const inner = await trx.savepoint("inner").execute();
    expect(inner.isTransaction).toBe(true);
    await inner.insertInto("item").values({ name: "undone", qty: 1 }).execute();
    await inner.rollbackToSavepoint("inner").execute();

    const released = await trx.savepoint("released_1").execute();
    await released.insertInto("item").values({ name: "nested", qty: 1 }).execute();
    await released.releaseSavepoint("released_1").execute();

    await trx.commit().execute();
    expect(await names()).toEqual(["nested", "outer"]);
  });

  it("rolls back released savepoints with the outer transaction", async () => {
    const trx = await db.startTransaction().execute();
    const sp = await trx.savepoint("sp").execute();
    await sp.insertInto("item").values({ name: "gone", qty: 1 }).execute();
    await sp.releaseSavepoint("sp").execute();
    await trx.rollback().execute();
    expect(await names()).toEqual([]);
  });

  it("rejects unsafe savepoint names", async () => {
    const trx = await db.startTransaction().execute();
    for (const name of ['x"; drop table item; --', "1st", "", "a b"])
      await expect(trx.savepoint(name).execute()).rejects.toThrow(
        /Invalid savepoint name/,
      );
    await trx.rollback().execute();
    expect(await names()).toEqual([]);
  });

  it("leaves a shared client open when closeOnDestroy is false", async () => {
    const client = createClient({ url });
    const shared = new (await import("kysely")).Kysely<DB>({
      dialect: new LibsqlDialect(client, { closeOnDestroy: false }),
    });
    await shared.insertInto("item").values({ name: "s", qty: 1 }).execute();
    await shared.destroy();
    expect(client.closed).toBe(false);
    expect((await client.execute("select count(*) as n from item")).rows[0].n).toBe(1);
    client.close();
  });
});

describe("createTursoKysely", () => {
  it("uses the native client for local URLs", async () => {
    const spy = vi.spyOn(native, "createClient");
    for (const local of [
      url,
      ":memory:",
      "http://127.0.0.1:8080",
      "ws://localhost:8080",
      "http://[::1]:8080",
    ]) {
      expect(isLocalLibsqlUrl(local)).toBe(true);
      await createTursoKysely({ env: { TURSO_DATABASE_URL: local } }).destroy();
    }
    expect(spy).toHaveBeenCalledTimes(5);
    expect(createWebClient).not.toHaveBeenCalled();
  });

  it("uses the web client for remote URLs, from the link or env", async () => {
    const spy = vi.spyOn(native, "createClient");
    createTursoKysely({
      env: {
        TURSO_DATABASE_URL: "libsql://app-org.turso.io",
        TURSO_AUTH_TOKEN: "jwt",
      },
    });
    createTursoKysely({
      link: "Other",
      urlEnv: "OTHER_URL",
      env: { OTHER_URL: "https://example.com" },
    });
    expect(isLocalLibsqlUrl("http://localhost.example.com")).toBe(false);
    expect(createWebClient.mock.calls).toEqual([
      [{ url: "libsql://app-org.turso.io", authToken: "jwt" }],
      [{ url: "https://example.com", authToken: undefined }],
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("guards production", () => {
    const remote = { TURSO_DATABASE_URL: "libsql://app-org.turso.io" };
    const create = (env: Record<string, string>) =>
      createTursoKysely({ production: true, env });
    expect(() => create({ ...remote, TURSO_AUTH_TOKEN: "jwt" })).not.toThrow();
    expect(() => create(remote)).toThrow(/libsql:\/\/ URL and an auth token/);
    expect(() =>
      create({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "jwt" }),
    ).toThrow(/libsql:\/\//);
    expect(() =>
      create({ TURSO_DATABASE_URL: "https://x.turso.io", TURSO_AUTH_TOKEN: "jwt" }),
    ).toThrow(/libsql:\/\//);
    expect(() => createTursoKysely({ env: {} })).toThrow(/No libSQL URL/);
  });

  it("passes plugins through", async () => {
    const camel = createTursoKysely<{ camelItem: { itemName: string } }>({
      env: { TURSO_DATABASE_URL: url },
      plugins: [new CamelCasePlugin()],
    });
    await camel.schema
      .createTable("camelItem")
      .addColumn("itemName", "text")
      .execute();
    await camel.insertInto("camelItem").values({ itemName: "x" }).execute();
    expect(await camel.selectFrom("camelItem").selectAll().execute()).toEqual([
      { itemName: "x" },
    ]);
    const raw = await sql<{ item_name: string }>`select * from camel_item`.execute(
      db,
    );
    expect(raw.rows).toEqual([{ item_name: "x" }]);
    await camel.destroy();
  });
});

describe("module boundaries", () => {
  const source = (file: string) =>
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const imports = (code: string) =>
    [...code.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gms)].map(
      (m) => m[1],
    );

  it("kysely.js statically imports only the web libSQL client", () => {
    const specifiers = imports(source("kysely.js"));
    expect(specifiers).toContain("@libsql/client/web");
    expect(specifiers).not.toContain("@libsql/client");
    expect(source("kysely.js")).not.toMatch(/import\(\s*["']@libsql\/client["']/);
  });

  it("the component and runtime never import Kysely or libSQL", () => {
    for (const file of ["index.ts", "runtime.js"])
      expect(
        imports(source(file)).filter((s) => /kysely|libsql/.test(s)),
      ).toEqual([]);
  });
});
