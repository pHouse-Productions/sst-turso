// Remote path against a real Hrana server: `sqld` (installed with the Turso
// CLI) and the pure HTTP client. Skipped when sqld is not on PATH.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client/web";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "../kysely.js";

const hasSqld = spawnSync("sqld", ["--version"]).status === 0;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe.skipIf(!hasSqld)("convertDeclaredTypes over Hrana (sqld)", () => {
  let dir: string;
  let sqld: ChildProcess;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sst-turso-sqld-"));
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    sqld = spawn(
      "sqld",
      ["--db-path", join(dir, "db"), "--http-listen-addr", `127.0.0.1:${port}`],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("sqld did not start");
  }, 15_000);

  afterAll(() => {
    sqld?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports declared types and round-trips Dates and booleans", async () => {
    const client = createClient({ url });
    const db = new Kysely<{
      t: { flag: boolean; at: Date };
    }>({ dialect: new LibsqlDialect(client, { convertDeclaredTypes: true }) });
    await sql`create table t (flag boolean, at datetime)`.execute(db);
    const at = new Date("2026-11-18T09:30:00.123Z");
    await db.transaction().execute((trx) =>
      trx.insertInto("t").values({ flag: true, at }).execute(),
    );
    expect(await db.selectFrom("t").selectAll().execute()).toEqual([
      { flag: true, at },
    ]);
    const raw = await client.execute("select flag, at, count(*) n from t");
    expect(raw.columnTypes).toEqual(["boolean", "datetime", ""]);
    expect(raw.rows[0].at).toBe(at.toISOString());
    await db.destroy();
  });
});
