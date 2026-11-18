import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// infra/turso.ts extends SST globals at load time; stub just enough of them.
let provider: Awaited<typeof import("../index")>["tursoProvider"];
beforeAll(async () => {
  class Stub {}
  Object.assign(globalThis, {
    $util: { ComponentResource: Stub, dynamic: { Resource: Stub } },
  });
  ({ tursoProvider: provider } = await import("../index"));
});
afterEach(() => vi.unstubAllGlobals());

const inputs = {
  apiToken: "platform-token",
  organization: "org",
  name: "app-production",
  group: "default",
  existing: false,
  deleteProtection: true,
  tokenVersion: 1,
};
const database = {
  database: {
    DbId: "db-1",
    Hostname: "app-production-org.turso.io",
    Name: "app-production",
  },
};

function mockApi(routes: Record<string, [number, unknown?]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const key = `${init.method} ${url.replace("https://api.turso.tech/v1/organizations/org", "")}`;
      calls.push(key);
      const [status, body] = routes[key] ?? [500, { error: `unmocked ${key}` }];
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      });
    }),
  );
  return calls;
}

describe("tursoProvider", () => {
  it("adopts an existing database without creating it", async () => {
    const calls = mockApi({
      "GET /databases/app-production": [200, database],
      "PATCH /databases/app-production/configuration": [200, {}],
      "POST /databases/app-production/auth/tokens?expiration=never&authorization=full-access":
        [200, { jwt: "db-token" }],
    });
    const result = await provider.create({ ...inputs, existing: true });
    expect(calls).not.toContain("POST /databases");
    expect(result).toMatchObject({
      id: "app-production",
      outs: {
        url: "libsql://app-production-org.turso.io",
        token: "db-token",
        dbId: "db-1",
      },
    });
  });

  it("creates a missing database unless existing is set", async () => {
    const routes: Record<string, [number, unknown?]> = {
      "GET /databases/app-production": [404, { error: "not found" }],
      "POST /databases": [200, database],
      "POST /databases/app-production/auth/tokens?expiration=never&authorization=full-access":
        [200, { jwt: "db-token" }],
    };
    const calls = mockApi(routes);
    await provider.create({ ...inputs, deleteProtection: false });
    expect(calls).toContain("POST /databases");
    expect(calls).not.toContain(
      "PATCH /databases/app-production/configuration",
    );

    const strict = mockApi(routes);
    await expect(
      provider.create({ ...inputs, existing: true }),
    ).rejects.toThrow(/never creates/);
    expect(strict).not.toContain("POST /databases");
  });

  it("replaces only on identity changes and keeps the token on update", async () => {
    const olds = {
      ...inputs,
      dbId: "db-1",
      hostname: "h",
      url: "libsql://h",
      token: "t",
    };
    expect(
      await provider.diff("app-production", olds, { ...inputs }),
    ).toMatchObject({ changes: false, replaces: [] });
    expect(
      (await provider.diff("x", olds, { ...inputs, apiToken: "new" })).replaces,
    ).toEqual([]);
    expect(
      (await provider.diff("x", olds, { ...inputs, group: "other" })).replaces,
    ).toEqual(["group"]);
    mockApi({});
    const updated = await provider.update("app-production", olds, {
      ...inputs,
      apiToken: "new",
    });
    expect(updated.outs).toMatchObject({
      apiToken: "new",
      token: "t",
      url: "libsql://h",
    });
  });

  it("never deletes adopted or delete-protected databases", async () => {
    const olds = {
      ...inputs,
      dbId: "db-1",
      hostname: "h",
      url: "libsql://h",
      token: "t",
    };
    const calls = mockApi({
      "DELETE /databases/app-production": [200, { database: "app-production" }],
    });
    await provider.delete("app-production", { ...olds, existing: true });
    await expect(provider.delete("app-production", olds)).rejects.toThrow(
      /Refusing/,
    );
    expect(calls).toEqual([]);
    await provider.delete("app-production", {
      ...olds,
      deleteProtection: false,
    });
    expect(calls).toEqual(["DELETE /databases/app-production"]);
  });

  it("rejects invalid names in check", async () => {
    const result = await provider.check(inputs, {
      ...inputs,
      name: "Bad_Name",
    });
    expect(result.failures).toHaveLength(1);
  });
});
