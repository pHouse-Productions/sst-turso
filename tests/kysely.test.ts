import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { CamelCasePlugin, type Kysely, sql } from "kysely";
import {
  createTursoKysely,
  declaredTypeConverter,
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

describe("convertDeclaredTypes", () => {
  interface TypedDB {
    session: {
      id: number | null;
      active: boolean | null;
      createdAt: Date | null;
      expiresAt: Date | null;
      note: string | null;
    };
  }
  const create = async (target: Kysely<TypedDB>) =>
    target.schema
      .createTable("session")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("active", sql`BOOLEAN`)
      .addColumn("createdAt", sql`DateTime`)
      .addColumn("expiresAt", sql`timestamp(3)`)
      .addColumn("note", "text")
      .execute();
  const createdAt = new Date("2026-11-18T09:30:00.123Z");

  it("round-trips Dates and booleans", async () => {
    const typed = createTursoKysely<TypedDB>({
      env: { TURSO_DATABASE_URL: url },
      convertDeclaredTypes: true,
    });
    await create(typed);
    const returned = await typed
      .insertInto("session")
      .values({ active: true, createdAt, expiresAt: null, note: "1" })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(returned).toEqual({
      id: 1,
      active: true,
      createdAt,
      expiresAt: null,
      note: "1",
    });
    await typed.transaction().execute((trx) =>
      trx
        .insertInto("session")
        .values({ active: false, createdAt, expiresAt: createdAt, note: null })
        .execute(),
    );
    const rows = await typed
      .selectFrom("session")
      .selectAll()
      .where("createdAt", "=", createdAt) // Date parameters bind as ISO text
      .orderBy("id")
      .execute();
    expect(rows.map((r) => [r.active, r.createdAt, r.expiresAt])).toEqual([
      [true, createdAt, null],
      [false, createdAt, createdAt],
    ]);
    expect(rows[1].createdAt).toBeInstanceOf(Date);

    // Stored as ISO text (read through the unconverted instance).
    const stored = await sql<{ t: string; v: string }>`
      select typeof(createdAt) t, createdAt v from session limit 1`.execute(db);
    expect(stored.rows).toEqual([{ t: "text", v: createdAt.toISOString() }]);
    // Expressions have no declared type and pass through.
    const raw = await sql<{ n: number; latest: string }>`
      select count(*) n, max(createdAt) latest from session`.execute(typed);
    expect(raw.rows).toEqual([{ n: 2, latest: createdAt.toISOString() }]);
    const counted = await typed
      .selectFrom("session")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(counted).toEqual({ n: 2 });
    await typed.destroy();
  });

  it("reads epoch milliseconds and SQLite datetime text as Dates", async () => {
    const typed = createTursoKysely<TypedDB>({
      env: { TURSO_DATABASE_URL: url },
      convertDeclaredTypes: true,
    });
    await create(typed);
    await sql`insert into session (active, createdAt, expiresAt) values
      (1, ${createdAt.getTime()}, '2026-11-18 09:30:00')`.execute(typed);
    expect(
      await typed
        .selectFrom("session")
        .select(["createdAt", "expiresAt"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ createdAt, expiresAt: new Date("2026-11-18T09:30:00Z") });
    await typed.destroy();
  });

  it("leaves values alone when off", async () => {
    const plain = db as unknown as Kysely<TypedDB>;
    await create(plain);
    await plain
      .insertInto("session")
      .values({ active: true, createdAt, expiresAt: null, note: null })
      .execute();
    expect(
      await plain
        .selectFrom("session")
        .select(["active", "createdAt"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ active: 1, createdAt: createdAt.getTime() });
  });

  it("matches declared type names case-insensitively", () => {
    const toBool = declaredTypeConverter("BOOLEAN")!;
    const toDate = declaredTypeConverter("DateTime")!;
    for (const t of ["boolean", "Bool", " BOOL "])
      expect(declaredTypeConverter(t)).toBe(toBool);
    for (const t of ["timestamp", "TIMESTAMP(3)", "date", "Datetime"])
      expect(declaredTypeConverter(t)).toBe(toDate);
    for (const t of ["", "text", "integer", "booleans", "timestamptz", null])
      expect(declaredTypeConverter(t)).toBeUndefined();

    expect([toBool(0), toBool(1), toBool(1n), toBool(2), toBool("x")]).toEqual(
      [false, true, true, 2, "x"],
    );
    const at = new Date("2026-11-18T04:00:00Z");
    for (const v of [
      "2026-11-18T04:00:00Z",
      "2026-11-18 04:00:00",
      "2026-11-18T09:30:00+05:30",
      "2026-11-18T09:30:00+0530",
      at.getTime(),
      BigInt(at.getTime()),
    ])
      expect(toDate(v)).toEqual(at);
    expect(toDate("2026-11-18")).toEqual(new Date("2026-11-18T00:00:00Z"));
    expect(toDate("not a date")).toBe("not a date");
  });

  it("converts remote (web client) results using their declared types", async () => {
    const at = createdAt.toISOString();
    webClient.execute
      .mockReset()
      .mockResolvedValueOnce({ columns: ["type"], columnTypes: ["TEXT"], rows: [], rowsAffected: 0 })
      .mockResolvedValueOnce({
        columns: ["active", "createdAt", "n"],
        columnTypes: ["BOOLEAN", "DATETIME", ""],
        rows: [[1, at, 3]],
        rowsAffected: 0,
      });
    const remote = createTursoKysely<TypedDB>({
      env: { TURSO_DATABASE_URL: "libsql://app-org.turso.io", TURSO_AUTH_TOKEN: "jwt" },
      convertDeclaredTypes: true,
    });
    const rows = await remote
      .selectFrom("session")
      .select(["active", "createdAt"])
      .where("createdAt", ">", createdAt)
      .execute();
    expect(rows).toEqual([{ active: true, createdAt, n: 3 }]);
    expect(webClient.execute).toHaveBeenCalledTimes(2);
    expect(webClient.execute.mock.calls[1][0].args).toEqual([at]);
  });

  it("fails clearly when the remote reports no declared types", async () => {
    webClient.execute
      .mockReset()
      .mockResolvedValue({ columns: ["type"], columnTypes: [""], rows: [], rowsAffected: 0 });
    const remote = createTursoKysely<TypedDB>({
      env: { TURSO_DATABASE_URL: "libsql://app-org.turso.io", TURSO_AUTH_TOKEN: "jwt" },
      convertDeclaredTypes: true,
    });
    const query = () => remote.selectFrom("session").selectAll().execute();
    await expect(query()).rejects.toThrow(/does not report them/);
    // A result without columnTypes fails too, rather than skipping conversion.
    webClient.execute
      .mockReset()
      .mockResolvedValueOnce({ columns: ["type"], columnTypes: ["TEXT"], rows: [], rowsAffected: 0 })
      .mockResolvedValueOnce({ columns: ["active"], rows: [[1]], rowsAffected: 0 });
    await expect(query()).rejects.toThrow(/does not report them/);
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
