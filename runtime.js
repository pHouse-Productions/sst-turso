// Runtime helper for apps that link a TursoDatabase. Plain JavaScript (with
// runtime.d.ts) so Next.js and other bundlers need no transpile config.
import { Resource } from "sst/resource";

/**
 * Resolve the libSQL connection: the SST-linked resource when present
 * (deployed stages, `sst dev`, `sst shell`), otherwise the env vars used for
 * plain local development, scripts and tests.
 */
export function tursoConnection(link = "Db", options = {}) {
  const urlEnv = options.urlEnv ?? "TURSO_DATABASE_URL";
  const tokenEnv = options.tokenEnv ?? "TURSO_AUTH_TOKEN";
  const env = options.env ?? process.env;
  let linked;
  try {
    // Accessing an unlinked resource throws outside SST.
    linked = Reflect.get(Resource, link);
  } catch {
    linked = undefined;
  }
  if (
    typeof linked === "object" &&
    linked !== null &&
    typeof linked.url === "string" &&
    linked.url
  ) {
    const token = typeof linked.token === "string" ? linked.token : "";
    return { url: linked.url, authToken: token || undefined };
  }
  return {
    url: env[urlEnv] || undefined,
    authToken: env[tokenEnv] || undefined,
  };
}
