import { afterEach, describe, expect, it } from "vitest";
import { tursoConnection } from "../runtime.js";
// @ts-expect-error -- plain JS fixture aliased to sst/resource in vitest.config
import { linked } from "./fixtures/sst-resource.js";

afterEach(() => {
  for (const key of Object.keys(linked)) delete linked[key];
});

describe("tursoConnection", () => {
  it("prefers the linked resource", () => {
    linked.Db = { url: "libsql://db.turso.io", token: "jwt" };
    const env = { TURSO_DATABASE_URL: "file:ignored.db" };
    expect(tursoConnection("Db", { env })).toEqual({
      url: "libsql://db.turso.io",
      authToken: "jwt",
    });
  });

  it("treats an empty linked token (sst dev) as no token", () => {
    linked.Db = { url: "file:.local/dev.db", token: "" };
    expect(tursoConnection()).toEqual({
      url: "file:.local/dev.db",
      authToken: undefined,
    });
  });

  it("falls back to env vars when unlinked", () => {
    const env = { TURSO_DATABASE_URL: "file:local.db", TURSO_AUTH_TOKEN: "" };
    expect(tursoConnection("Db", { env })).toEqual({
      url: "file:local.db",
      authToken: undefined,
    });
    expect(
      tursoConnection("Other", {
        env: { DB_URL: "file:x.db" },
        urlEnv: "DB_URL",
      }),
    ).toEqual({
      url: "file:x.db",
      authToken: undefined,
    });
  });

  it("ignores a malformed linked value", () => {
    linked.Db = { url: 42 };
    expect(tursoConnection("Db", { env: {} })).toEqual({
      url: undefined,
      authToken: undefined,
    });
  });
});
