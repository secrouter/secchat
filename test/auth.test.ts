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
import { mintSession, verifySession } from "../src/auth/session.ts";
import { challengeS256, newVerifier, verifyIdToken } from "../src/auth/oidc.ts";

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

// ── session.ts — the SecChat-minted login session (see test/sso.exit.test.ts for the full BFF
// flow this feeds into; these are the module's own unit-level security properties). ──────────────

test("session.ts — mintSession/verifySession", async (t) => {
  const SECRET = "unit-test-session-secret";
  const key = new TextEncoder().encode(SECRET);
  const principal = { sub: "user-9", email: "u9@example.com", displayName: "User Nine", groups: ["eng"] };

  await t.test("mint then verify round-trips the Principal", async () => {
    const token = await mintSession(principal, SECRET, 3600);
    assert.deepEqual(await verifySession(token, SECRET), principal);
  });

  await t.test("a token signed with the wrong secret is rejected", async () => {
    const token = await mintSession(principal, SECRET, 3600);
    await assert.rejects(() => verifySession(token, "a-different-secret"));
  });

  await t.test("pins algorithms:[HS256] — a token signed HS384 with the SAME key is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ groups: [] })
      .setProtectedHeader({ alg: "HS384" })
      .setSubject(principal.sub)
      .setIssuer("secchat")
      .setAudience("secchat")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    await assert.rejects(() => verifySession(token, SECRET));
  });

  await t.test("pins audience 'secchat' — a token minted for a different audience is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ groups: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(principal.sub)
      .setIssuer("secchat")
      .setAudience("someone-else")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    await assert.rejects(() => verifySession(token, SECRET));
  });

  await t.test("pins issuer 'secchat' — a token from a different issuer is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ groups: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(principal.sub)
      .setIssuer("not-secchat")
      .setAudience("secchat")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    await assert.rejects(() => verifySession(token, SECRET));
  });

  await t.test("an already-expired session token is rejected", async () => {
    const token = await mintSession(principal, SECRET, -10);
    await assert.rejects(() => verifySession(token, SECRET));
  });
});

// ── oidc.ts — PKCE + id_token verification (see test/sso.exit.test.ts for the full flow through
// a fake IdP; these isolate the module's own security properties with hand-crafted tokens). ──────

test("oidc.ts — PKCE + verifyIdToken", async (t) => {
  await t.test("challengeS256 matches the RFC 7636 Appendix B worked example", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(challengeS256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  await t.test("newVerifier produces a fresh, already-URL-safe verifier every call", () => {
    const a = newVerifier();
    const b = newVerifier();
    assert.notEqual(a, b);
    assert.ok(a.length >= 43); // RFC 7636's high-entropy end of the allowed 43-128 range
    assert.equal(encodeURIComponent(a), a); // base64url has nothing left for percent-encoding to touch
  });

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "vid-1", alg: "RS256", use: "sig" };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

  try {
    const { port } = server.address() as AddressInfo;
    const jwksUri = `http://127.0.0.1:${port}/jwks`;
    const issuer = "https://fake-idp.example/o/x";
    const clientId = "secchatng";
    const REAL_NONCE = "the-real-nonce";

    async function mintIdToken(overrides: { nonce?: string; audience?: string; issuer?: string } = {}): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: "a@example.com", name: "A", groups: [], nonce: overrides.nonce ?? REAL_NONCE })
        .setProtectedHeader({ alg: "RS256", kid: "vid-1" })
        .setSubject("sub-1")
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
    }

    await t.test("a valid id_token with a matching nonce verifies to a Principal", async () => {
      const idToken = await mintIdToken();
      const principal = await verifyIdToken(idToken, { jwksUri, issuer, clientId, nonce: REAL_NONCE });
      assert.equal(principal.sub, "sub-1");
      assert.deepEqual(principal.groups, []);
    });

    await t.test("a mismatched nonce is rejected (replay/injection guard)", async () => {
      const idToken = await mintIdToken({ nonce: "attacker-supplied-nonce" });
      await assert.rejects(() => verifyIdToken(idToken, { jwksUri, issuer, clientId, nonce: REAL_NONCE }));
    });

    await t.test("a token for the wrong audience is rejected", async () => {
      const idToken = await mintIdToken({ audience: "some-other-client" });
      await assert.rejects(() => verifyIdToken(idToken, { jwksUri, issuer, clientId, nonce: REAL_NONCE }));
    });

    await t.test("a token from the wrong issuer is rejected", async () => {
      const idToken = await mintIdToken({ issuer: "https://not-the-real-idp.example" });
      await assert.rejects(() => verifyIdToken(idToken, { jwksUri, issuer, clientId, nonce: REAL_NONCE }));
    });

    await t.test("alg-confusion: an HS256 token 'signed' using the RSA public key as an HMAC secret is rejected", async () => {
      // The classic RS256->HS256 downgrade attack: without a pinned algorithm, a verifier handed
      // the same (public, non-secret) key material for both asymmetric and symmetric checks could
      // be tricked into accepting a token an attacker self-signed by treating that public key as
      // an HMAC secret. verifyIdToken pins algorithms:["RS256"], so an HS256 token is rejected
      // outright — regardless of what "key" was used to produce its signature.
      const forgedKey = new TextEncoder().encode(JSON.stringify(jwk));
      const now = Math.floor(Date.now() / 1000);
      const forged = await new SignJWT({ email: "attacker@example.com", groups: ["secchat-admins"], nonce: REAL_NONCE })
        .setProtectedHeader({ alg: "HS256", kid: "vid-1" })
        .setSubject("attacker")
        .setIssuer(issuer)
        .setAudience(clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(forgedKey);
      await assert.rejects(() => verifyIdToken(forged, { jwksUri, issuer, clientId, nonce: REAL_NONCE }));
    });
  } finally {
    server.close();
  }
});
