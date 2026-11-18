export interface TursoConnection {
  /** `libsql://…` when linked to Turso, `file:…` under `sst dev` or locally. */
  url?: string;
  /** Database auth token; undefined for local files. */
  authToken?: string;
}

export interface TursoConnectionOptions {
  /** Fallback env var for the URL. Defaults to TURSO_DATABASE_URL. */
  urlEnv?: string;
  /** Fallback env var for the token. Defaults to TURSO_AUTH_TOKEN. */
  tokenEnv?: string;
  /** Environment to read fallbacks from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * The linked `Resource[link]` (default "Db") when present, otherwise the
 * fallback env vars.
 */
export function tursoConnection(
  link?: string,
  options?: TursoConnectionOptions,
): TursoConnection;
