/**
 * TursoDatabase: an SST (v3/v4) component for Turso (libSQL).
 *
 * It is a Pulumi dynamic resource that calls the Turso Platform API, with no
 * provider plugin. (In Nov 2026 the only Turso Terraform providers were
 * community ones: celest-dev, which is archived and whose Pulumi package is
 * deprecated, and jpedroh, which had seen no activity for a year.)
 *
 * Install: npm i github:pHouse-Productions/sst-turso#v0.2.0
 *
 * Usage (sst.config.ts):
 *
 *   async run() {
 *     const { TursoDatabase } = await import("sst-turso");
 *     const db = new TursoDatabase("Db", {
 *       organization: "my-org",
 *       name: `${$app.name}-${$app.stage}`,
 *    *     });
 *     new sst.aws.Nextjs("Web", { link: [db] }); // Resource.Db.url / .token
 *   }
 *
 * The import must be dynamic, inside run(): SST rejects top-level imports.
 * This file uses SST's globals ($util, sst, $app, $dev). SST's bundler injects
 * them at build time, and the consumer's sst.config.ts (which references
 * .sst/platform/config.d.ts) supplies their types, so there is no build step.
 *
 * - Secret: one SST secret, `TursoApiToken`, holds a Turso Platform API token
 *   (`turso auth api-tokens mint <name>`). It is created on first use and
 *   shared by every TursoDatabase in the app. Override it with `apiToken`.
 * - Adoption: create looks the database up by name and adopts it if it
 *   already exists, so no data is touched, including databases created
 *   before you adopted this component. With `existing: true` it only looks
 *   the database up, fails if it is missing, and never deletes it.
 * - Protection: `protect` (default: stage === "production") sets Pulumi
 *   `protect` + `retainOnDelete` and enables Turso's server-side
 *   delete_protection, so removing the stage or the component cannot delete it.
 * - Token: a full-access, non-expiring database token is minted on create and
 *   kept in state as a secret. Bump `tokenVersion` to mint a replacement; this
 *   does not revoke older tokens (`turso db tokens invalidate <db>` does).
 * - `sst dev`: Turso is never called. The link resolves to `dev.url`
 *   (default `file:.local/dev.db`, so git-ignore `.local/`) with an empty token;
 *   @libsql/client opens it with the same driver. `dev: false` turns this off.
 * - Migrations: `npx sst shell --stage <stage> -- npx drizzle-kit migrate`,
 *   with drizzle.config.ts reading Resource.Db (see README.md).
 */

const TURSO_API = "https://api.turso.tech/v1";

export interface TursoDatabaseArgs {
  /** Turso organization slug. */
  organization: $util.Input<string>;
  /** Database name: lowercase letters, numbers and dashes, at most 64 characters. */
  name: $util.Input<string>;
  /** Existing Turso group to create the database in. Defaults to "default". */
  group?: $util.Input<string>;
  /** Platform API token. Defaults to the shared `TursoApiToken` SST secret. */
  apiToken?: $util.Input<string>;
  /** Only adopt an existing database: never create, never delete. */
  existing?: boolean;
  /** Retain, protect and delete-protect. Defaults to stage === "production". */
  protect?: boolean;
  /** Bump to mint a replacement database token. */
  tokenVersion?: number;
  /** What to link under `sst dev`, or false to use Turso there too. */
  dev?: false | { url?: string; token?: string };
}

/** Dynamic resource inputs, also kept in its state. */
interface ProviderInputs {
  apiToken: string;
  organization: string;
  name: string;
  group: string;
  existing: boolean;
  deleteProtection: boolean;
  tokenVersion: number;
}

interface ProviderOutputs extends ProviderInputs {
  dbId: string;
  hostname: string;
  url: string;
  token: string;
}

/** Fields read from the Turso API's database object. */
interface TursoDatabaseInfo {
  DbId: string;
  Hostname: string;
  Name: string;
}

/**
 * The provider is serialized into Pulumi state and runs in a separate process,
 * so it must only use its own helpers and Node globals such as `fetch`.
 */
export const tursoProvider = {
  async request(
    inputs: Pick<ProviderInputs, "apiToken" | "organization">,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(
      `${TURSO_API}/organizations/${encodeURIComponent(inputs.organization)}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${inputs.apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!response.ok && response.status !== 404) {
      const error =
        typeof json === "object" && json && "error" in json
          ? String(json.error)
          : text;
      throw new Error(
        `Turso API ${method} ${path} failed (${response.status}): ${error}`,
      );
    }
    return { status: response.status, json };
  },

  parseDatabase(json: unknown): TursoDatabaseInfo {
    const db =
      typeof json === "object" && json && "database" in json
        ? json.database
        : undefined;
    if (
      typeof db !== "object" ||
      !db ||
      !("DbId" in db) ||
      !("Hostname" in db) ||
      !("Name" in db) ||
      typeof db.DbId !== "string" ||
      typeof db.Hostname !== "string" ||
      typeof db.Name !== "string"
    )
      throw new Error("Unexpected Turso API database response.");
    return { DbId: db.DbId, Hostname: db.Hostname, Name: db.Name };
  },

  async lookup(inputs: ProviderInputs) {
    const path = `/databases/${encodeURIComponent(inputs.name)}`;
    const { status, json } = await this.request(inputs, "GET", path);
    return status === 404 ? undefined : this.parseDatabase(json);
  },

  async setDeleteProtection(inputs: ProviderInputs) {
    const path = `/databases/${encodeURIComponent(inputs.name)}/configuration`;
    const { status } = await this.request(inputs, "PATCH", path, {
      delete_protection: inputs.deleteProtection,
    });
    if (status === 404)
      throw new Error(`Turso database ${inputs.name} vanished.`);
  },

  async mintToken(inputs: ProviderInputs) {
    const path = `/databases/${encodeURIComponent(inputs.name)}/auth/tokens?expiration=never&authorization=full-access`;
    const { status, json } = await this.request(inputs, "POST", path);
    const jwt =
      typeof json === "object" && json && "jwt" in json ? json.jwt : undefined;
    if (status === 404 || typeof jwt !== "string" || !jwt)
      throw new Error(
        `Could not mint a token for Turso database ${inputs.name}.`,
      );
    return jwt;
  },

  outputs(inputs: ProviderInputs, db: TursoDatabaseInfo, token: string) {
    return {
      ...inputs,
      dbId: db.DbId,
      hostname: db.Hostname,
      url: `libsql://${db.Hostname}`,
      token,
    } satisfies ProviderOutputs;
  },

  async check(_olds: ProviderInputs, news: ProviderInputs) {
    // Pulumi passes not-yet-known preview values as this sentinel.
    const unknown = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";
    const failures = [];
    if (news.name !== unknown && !/^[a-z0-9-]{1,64}$/.test(news.name))
      failures.push({
        property: "name",
        reason: "Use lowercase letters, numbers and dashes (at most 64).",
      });
    return { inputs: news, failures };
  },

  async create(inputs: ProviderInputs) {
    let db = await this.lookup(inputs);
    if (!db) {
      if (inputs.existing)
        throw new Error(
          `Turso database ${inputs.name} does not exist; existing: true never creates one.`,
        );
      const { status, json } = await this.request(
        inputs,
        "POST",
        "/databases",
        {
          name: inputs.name,
          group: inputs.group,
        },
      );
      if (status === 404) throw new Error("Turso organization not found.");
      db = this.parseDatabase(json);
    }
    if (inputs.deleteProtection) await this.setDeleteProtection(inputs);
    const token = await this.mintToken(inputs);
    return { id: inputs.name, outs: this.outputs(inputs, db, token) };
  },

  async read(id: string, props: ProviderOutputs) {
    const db = await this.lookup({ ...props, name: id });
    if (!db) return {};
    return { id, props: this.outputs({ ...props, name: id }, db, props.token) };
  },

  async diff(_id: string, olds: ProviderOutputs, news: ProviderInputs) {
    const replaces = (["organization", "name", "group"] as const).filter(
      (key) => olds[key] !== news[key],
    );
    const changed = (
      ["apiToken", "existing", "deleteProtection", "tokenVersion"] as const
    ).some((key) => olds[key] !== news[key]);
    return {
      changes: replaces.length > 0 || changed,
      replaces,
      deleteBeforeReplace: false,
    };
  },

  async update(_id: string, olds: ProviderOutputs, news: ProviderInputs) {
    if (olds.deleteProtection !== news.deleteProtection)
      await this.setDeleteProtection(news);
    const token =
      olds.tokenVersion !== news.tokenVersion
        ? await this.mintToken(news)
        : olds.token;
    return {
      outs: {
        ...news,
        dbId: olds.dbId,
        hostname: olds.hostname,
        url: olds.url,
        token,
      } satisfies ProviderOutputs,
    };
  },

  async delete(id: string, olds: ProviderOutputs) {
    // Adopted-only databases are never ours to delete.
    if (olds.existing) return;
    if (olds.deleteProtection)
      throw new Error(
        `Refusing to delete delete-protected Turso database ${id}. Set protect: false and deploy first.`,
      );
    await this.request(olds, "DELETE", `/databases/${encodeURIComponent(id)}`);
  },
};

let sharedApiToken: $util.Output<string> | undefined;

/** The one `TursoApiToken` SST secret shared by every database in the app. */
function defaultApiToken() {
  sharedApiToken ??= new sst.Secret("TursoApiToken").value;
  return sharedApiToken;
}

class TursoDatabaseResource extends $util.dynamic.Resource {
  declare readonly url: $util.Output<string>;
  declare readonly token: $util.Output<string>;
  declare readonly hostname: $util.Output<string>;
  constructor(
    name: string,
    props: { [K in keyof ProviderInputs]: $util.Input<ProviderInputs[K]> },
    opts: $util.CustomResourceOptions,
  ) {
    super(
      tursoProvider,
      name,
      {
        ...props,
        dbId: undefined,
        hostname: undefined,
        url: undefined,
        token: undefined,
      },
      { ...opts, additionalSecretOutputs: ["apiToken", "token"] },
    );
  }
}

export class TursoDatabase extends $util.ComponentResource {
  /** The Turso database name. */
  readonly name: $util.Output<string>;
  /** `libsql://…` in deployed stages, `file:…` under `sst dev`. */
  readonly url: $util.Output<string>;
  /** Database auth token; empty under `sst dev`. */
  readonly token: $util.Output<string>;

  constructor(
    name: string,
    args: TursoDatabaseArgs,
    opts?: $util.ComponentResourceOptions,
  ) {
    super("turso:index:Database", name, {}, opts);
    this.name = $util.output(args.name);
    const dev = args.dev ?? {};
    if ($dev && dev) {
      this.url = $util.output(dev.url ?? "file:.local/dev.db");
      this.token = $util.secret(dev.token ?? "");
    } else {
      const protect = args.protect ?? $app.stage === "production";
      const db = new TursoDatabaseResource(
        `${name}Database`,
        {
          apiToken: args.apiToken ?? defaultApiToken(),
          organization: args.organization,
          name: args.name,
          group: args.group ?? "default",
          existing: args.existing ?? false,
          deleteProtection: protect,
          tokenVersion: args.tokenVersion ?? 1,
        },
        { parent: this, protect, retainOnDelete: protect },
      );
      this.url = db.url;
      this.token = $util.secret(db.token);
    }
    this.registerOutputs({ url: this.url });
  }

  /** @internal SST Linkable: exposes Resource.<Name>.url and .token. */
  getSSTLink() {
    return { properties: { url: this.url, token: this.token } };
  }
}
