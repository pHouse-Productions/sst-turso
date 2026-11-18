// Kysely over libSQL for apps that link a TursoDatabase. Plain JavaScript
// (with kysely.d.ts) so Next.js and other bundlers need no transpile config.
//
// Only the pure HTTP client (`@libsql/client/web`) is imported statically. The
// default `@libsql/client` entry loads a native SQLite binary that is missing
// from Lambda bundles, so it is required lazily, and only for local URLs.
import { createRequire } from "node:module";
import { createClient as createWebClient } from "@libsql/client/web";
import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { tursoConnection } from "./runtime.js";

/**
 * Kysely dialect over an existing libSQL client (local file, `turso dev` or
 * remote Turso). `db.destroy()` closes the client unless `closeOnDestroy` is
 * false.
 */
export class LibsqlDialect {
  #client;
  #closeOnDestroy;
  constructor(client, options = {}) {
    this.#client = client;
    this.#closeOnDestroy = options.closeOnDestroy ?? true;
  }
  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver() {
    return new LibsqlDriver(this.#client, this.#closeOnDestroy);
  }
  createIntrospector(db) {
    return new SqliteIntrospector(db);
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
}

class LibsqlDriver {
  #client;
  #closeOnDestroy;
  constructor(client, closeOnDestroy) {
    this.#client = client;
    this.#closeOnDestroy = closeOnDestroy;
  }
  async init() {}
  async acquireConnection() {
    return new LibsqlConnection(this.#client);
  }
  async beginTransaction(connection) {
    await connection.begin();
  }
  async commitTransaction(connection) {
    await connection.commit();
  }
  async rollbackTransaction(connection) {
    await connection.rollback();
  }
  async savepoint(connection, name) {
    await connection.executeQuery(savepointCommand("savepoint", name));
  }
  async rollbackToSavepoint(connection, name) {
    await connection.executeQuery(savepointCommand("rollback to", name));
  }
  async releaseSavepoint(connection, name) {
    await connection.executeQuery(savepointCommand("release", name));
  }
  async releaseConnection() {}
  async destroy() {
    if (this.#closeOnDestroy) this.#client.close();
  }
}

const savepointName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function savepointCommand(command, name) {
  if (typeof name !== "string" || !savepointName.test(name))
    throw new Error(
      `Invalid savepoint name ${JSON.stringify(name)}: use letters, digits and underscores, starting with a letter or underscore.`,
    );
  // Validated above, so quoting cannot be escaped.
  return CompiledQuery.raw(`${command} "${name}"`);
}

class LibsqlConnection {
  #client;
  #transaction;
  constructor(client) {
    this.#client = client;
  }
  async executeQuery(compiled) {
    const result = await (this.#transaction ?? this.#client).execute({
      sql: compiled.sql,
      args: compiled.parameters,
    });
    // libSQL rows are array-like objects; hand Kysely plain records.
    const rows = result.rows.map((row) =>
      Object.fromEntries(result.columns.map((name, i) => [name, row[i]])),
    );
    return {
      rows,
      numAffectedRows: BigInt(result.rowsAffected),
      insertId: result.lastInsertRowid,
    };
  }
  async begin() {
    if (this.#transaction) throw new Error("Transaction already in progress.");
    this.#transaction = await this.#client.transaction("write");
  }
  async commit() {
    await this.#finish((tx) => tx.commit());
  }
  async rollback() {
    await this.#finish((tx) => tx.rollback());
  }
  async #finish(action) {
    const tx = this.#transaction;
    if (!tx) throw new Error("No transaction in progress.");
    this.#transaction = undefined;
    try {
      await action(tx);
    } finally {
      tx.close();
    }
  }
  async *streamQuery() {
    throw new Error("The libSQL dialect does not support streaming.");
  }
}

const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];

/** True for `file:` / `:memory:` URLs and http(s)/ws(s) URLs on loopback. */
export function isLocalLibsqlUrl(url) {
  if (url === ":memory:") return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "file:" ||
    (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) &&
      loopbackHosts.includes(parsed.hostname))
  );
}

function nativeClient(config) {
  // Lazy: production bundles never resolve the native SQLite binary.
  const native = createRequire(import.meta.url)("@libsql/client");
  return native.createClient(config);
}

/**
 * A Kysely instance for the linked TursoDatabase (or the fallback env vars).
 * Remote URLs use `@libsql/client/web`; local URLs use the native client.
 */
export function createTursoKysely(options = {}) {
  const { link, urlEnv, tokenEnv, env, production = false, plugins } = options;
  const { url, authToken } = tursoConnection(link, { urlEnv, tokenEnv, env });
  if (!url)
    throw new Error(
      `No libSQL URL: link a TursoDatabase as "${link ?? "Db"}" or set ${urlEnv ?? "TURSO_DATABASE_URL"}.`,
    );
  if (production && (!url.startsWith("libsql://") || !authToken))
    throw new Error(
      "Production requires a remote libsql:// URL and an auth token.",
    );
  const client = isLocalLibsqlUrl(url)
    ? nativeClient({ url, authToken })
    : createWebClient({ url, authToken });
  return new Kysely({
    dialect: new LibsqlDialect(client),
    ...(plugins ? { plugins } : {}),
  });
}
