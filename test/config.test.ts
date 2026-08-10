import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const base = { SECCHAT_OIDC_ISSUER: "https://sso.sec.internal/application/o/secchat/", SECCHAT_OIDC_AUDIENCE: "secchat" };

test("loadConfig fills defaults and derives the JWKS url from the issuer", () => {
  const c = loadConfig(base);
  assert.equal(c.oidcAudience, "secchat");
  // Issuer is kept EXACTLY as configured (trailing slash preserved) — OIDC's `iss` is an exact-
  // match identifier and Authentik's canonical issuer ends with "/". The JWKS url strips the
  // trailing slash only when composing, so it never doubles up.
  assert.equal(c.oidcIssuer, "https://sso.sec.internal/application/o/secchat/");
  assert.equal(c.jwksUrl, "https://sso.sec.internal/application/o/secchat/.well-known/jwks.json");
  assert.equal(c.port, 47010);
  assert.equal(c.databaseUrl, undefined); // no DATABASE_URL ⇒ in-memory store
});

test("loadConfig fails closed on a missing required value", () => {
  assert.throws(() => loadConfig({ SECCHAT_OIDC_ISSUER: "x" }), /SECCHAT_OIDC_AUDIENCE/);
});
