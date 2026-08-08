// Offline JWKS verification tests: a throwaway RS256 keypair stands in for SecSSO (Authentik),
// served from a loopback-only http.Server so makeVerifyToken exercises its real fetch path
// (createRemoteJWKSet → jwtVerify) without ever touching the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bearerFromHeader } from "../src/auth/bearer.ts";
import { makeVerifyToken } from "../src/auth/jwks.ts";

const ISSUER = "https://sso.sec.internal/application/o/secchat";
const AUDIENCE = "secchat";

test("makeVerifyToken — SecSSO (Authentik) JWKS verification", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-1", alg: "RS256", use: "sig" };

  // Stand-in IdP: serves the one JWK unconditionally, on loopback only, port 0 (OS-assigned).
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  try {
    const { port } = server.address() as AddressInfo;
    const verify = makeVerifyToken({
      jwksUrl: `http://127.0.0.1:${port}/jwks`,
      oidcIssuer: ISSUER,
      oidcAudience: AUDIENCE,
    });

    /** Mints a token signed by the throwaway key; `kid` matches the JWKS entry served above. */
    async function mint(overrides: { audience?: string; issuer?: string; expiresAt?: number } = {}): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: "ada@example.com", name: "Ada Lovelace", groups: ["eng"] })
        .setProtectedHeader({ alg: "RS256", kid: "test-1" })
        .setSubject("user-1")
        .setIssuer(overrides.issuer ?? ISSUER)
        .setAudience(overrides.audience ?? AUDIENCE)
        .setExpirationTime(overrides.expiresAt ?? now + 300)
        .sign(privateKey);
    }

    await t.test("a validly signed token maps to its Principal", async () => {
      const token = await mint();
      assert.deepEqual(await verify(token), {
        sub: "user-1",
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        groups: ["eng"],
      });
    });

    await t.test("a token for the wrong audience throws", async () => {
      const token = await mint({ audience: "some-other-app" });
      await assert.rejects(() => verify(token));
    });

    await t.test("a token from the wrong issuer throws", async () => {
      const token = await mint({ issuer: "https://not-our-sso.example" });
      await assert.rejects(() => verify(token));
    });

    await t.test("an already-expired token throws", async () => {
      const token = await mint({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
      await assert.rejects(() => verify(token));
    });
  } finally {
    server.close();
  }
});

test("bearerFromHeader", () => {
  assert.equal(bearerFromHeader("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerFromHeader("bearer abc.def.ghi"), "abc.def.ghi"); // case-insensitive scheme
  assert.equal(bearerFromHeader("BEARER   abc.def.ghi"), "abc.def.ghi"); // extra inner whitespace
  assert.equal(bearerFromHeader("  Bearer abc.def.ghi  "), "abc.def.ghi"); // outer whitespace trimmed
  assert.equal(bearerFromHeader("Basic abc.def.ghi"), null); // wrong scheme
  assert.equal(bearerFromHeader("Bearer"), null); // missing token
  assert.equal(bearerFromHeader(""), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(bearerFromHeader(null), null);
});
