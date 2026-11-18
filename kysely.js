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
 * false. `convertDeclaredTypes` binds Dates as ISO text and reads declared
 * boolean/date columns back as booleans and Dates.
 */
export class LibsqlDialect {
  #client;
  #options;
  constructor(client, options = {}) {
    this.#client = client;
    this.#options = {
      closeOnDestroy: options.closeOnDestroy ?? true,
      convertDeclaredTypes: options.convertDeclaredTypes ?? false,
    };
  }
  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver() {
    return new LibsqlDriver(this.#client, this.#options);
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
  #options;
  constructor(client, options) {
    this.#client = client;
    this.#options = options;
  }
  async init() {
    if (this.#options.convertDeclaredTypes)
      await assertDeclaredTypes(this.#client);
  }
  async acquireConnection() {
    return new LibsqlConnection(
      this.#client,
      this.#options.convertDeclaredTypes,
    );
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
    if (this.#options.closeOnDestroy) this.#client.close();
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
  #convert;
  #transaction;
  constructor(client, convertDeclaredTypes) {
    this.#client = client;
    this.#convert = convertDeclaredTypes;
  }
  async executeQuery(compiled) {
    const result = await (this.#transaction ?? this.#client).execute({
      sql: compiled.sql,
      args: this.#convert
        ? compiled.parameters.map(toParameter)
        : compiled.parameters,
    });
    const converters = this.#convert
      ? columnConverters(result)
      : result.columns.map(() => undefined);
    // libSQL rows are array-like objects; hand Kysely plain records.
    const rows = result.rows.map((row) =>
      Object.fromEntries(
        result.columns.map((name, i) => {
          const value = row[i];
          const convert = converters[i];
          return [name, convert && value != null ? convert(value) : value];
        }),
      ),
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

// libSQL binds a Date as epoch milliseconds; store ISO-8601 UTC text instead,
// SQLite's own date format (and Better Auth's).
function toParameter(value) {
  return value instanceof Date ? value.toISOString() : value;
}

const booleanTypes = new Set(["boolean", "bool"]);
const dateTypes = new Set(["timestamp", "datetime", "date"]);

/** The read converter for a declared column type, e.g. "DATETIME" or "bool". */
export function declaredTypeConverter(declaredType) {
  const type = String(declaredType ?? "")
    .toLowerCase()
    .replace(/\(.*$/, "")
    .trim();
  if (booleanTypes.has(type)) return toBoolean;
  if (dateTypes.has(type)) return toDate;
  return undefined;
}

function toBoolean(value) {
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  return value;
}

// SQLite datetime text is UTC even without a zone ("2026-11-18 09:30:00").
const isoDate =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
function toDate(value) {
  if (typeof value === "number" || typeof value === "bigint")
    return new Date(Number(value));
  if (typeof value !== "string") return value;
  const match = isoDate.exec(value.trim());
  if (!match) return value;
  const [, day, time = "00:00:00", zone = "Z"] = match;
  const offset = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const date = new Date(`${day}T${time}${offset}`);
  return Number.isNaN(date.getTime()) ? value : date;
}

function columnConverters(result) {
  const types = result.columnTypes;
  if (!Array.isArray(types) || types.length !== result.columns.length)
    throw missingDeclaredTypes();
  return types.map(declaredTypeConverter);
}

function missingDeclaredTypes() {
  return new Error(
    "convertDeclaredTypes needs declared column types (ResultSet.columnTypes, from Hrana decltype), but this libSQL client or server does not report them. Upgrade it or turn the option off.",
  );
}

// sqlite_schema columns are declared TEXT, so a server that reports declared
// types answers "TEXT" here, even with no rows.
async function assertDeclaredTypes(client) {
  const result = await client.execute(
    "select type from sqlite_schema limit 0",
  );
  if (String(result.columnTypes?.[0] ?? "").toLowerCase() !== "text")
    throw missingDeclaredTypes();
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
  const {
    link,
    urlEnv,
    tokenEnv,
    env,
    production = false,
    plugins,
    convertDeclaredTypes,
  } = options;
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
    dialect: new LibsqlDialect(client, { convertDeclaredTypes }),
    ...(plugins ? { plugins } : {}),
  });
}
