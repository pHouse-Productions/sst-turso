import type { Client } from "@libsql/client";
import type {
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  KyselyPlugin,
  QueryCompiler,
} from "kysely";
import type { TursoConnectionOptions } from "./runtime.js";

export interface LibsqlDialectOptions {
  /**
   * Close the client when the Kysely instance is destroyed. Defaults to true:
   * the dialect owns the client. Pass false when the client is shared, e.g.
   * with an auth library that holds the same client.
   */
  closeOnDestroy?: boolean;
}

/**
 * Kysely dialect over an existing libSQL client (local file, `turso dev` or
 * remote Turso). Supports transactions, `startTransaction()` and savepoints.
 * Streaming is not supported.
 */
export declare class LibsqlDialect implements Dialect {
  constructor(client: Client, options?: LibsqlDialectOptions);
  createAdapter(): DialectAdapter;
  createDriver(): Driver;
  createIntrospector(db: Kysely<any>): DatabaseIntrospector;
  createQueryCompiler(): QueryCompiler;
}

export interface CreateTursoKyselyOptions extends TursoConnectionOptions {
  /** SST link name passed to `tursoConnection`. Defaults to "Db". */
  link?: string;
  /**
   * Refuse anything but a remote `libsql://` URL with an auth token, so a
   * misconfigured deploy fails fast instead of writing to a local file.
   */
  production?: boolean;
  /** Optional Kysely plugins, e.g. `CamelCasePlugin`. None by default. */
  plugins?: KyselyPlugin[];
}

/**
 * A Kysely instance for the linked TursoDatabase, or the fallback env vars.
 * Remote URLs use `@libsql/client/web`. `file:`, `:memory:` and loopback URLs
 * use the native `@libsql/client`, loaded lazily so deployed bundles never
 * resolve its SQLite binary. `db.destroy()` closes the client.
 */
export declare function createTursoKysely<DB>(
  options?: CreateTursoKyselyOptions,
): Kysely<DB>;

/** True for `file:` / `:memory:` URLs and http(s)/ws(s) URLs on loopback. */
export declare function isLocalLibsqlUrl(url: string): boolean;
