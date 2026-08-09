// Unit tests for the privileged-capability model (src/auth/capabilities.ts) + the step-up token
// (src/auth/stepup.ts): the two gates (group + freshness), their ordering, the safe defaults, and
// the step-up token round-trip / rejection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeCapability, defaultCapabilityPolicy } from "../src/auth/capabilities.ts";
import { makeStepUp } from "../src/auth/stepup.ts";
import type { Capability, CapabilityPolicy } from "../src/auth/capabilities.ts";
import type { Principal } from "../src/types.ts";

const alice: Principal = { sub: "alice", groups: ["sec-officers"] };
const bob: Principal = { sub: "bob", groups: [] };

// A policy that gates redaction on a group AND a 300s step-up window.
const policy = {
  ...defaultCapabilityPolicy("admins"),
  "message.redact": { group: "sec-officers", stepUpSeconds: 300 },
} as CapabilityPolicy;

test("group gate: a member is allowed (fresh), a non-member is forbidden", () => {
  assert.deepEqual(authorizeCapability(alice, "message.redact", policy, 10), { allow: true });
  const denied = authorizeCapability(bob, "message.redact", policy, 10);
  assert.deepEqual(denied, { allow: false, reason: "forbidden_group", group: "sec-officers" });
});

test("step-up gate: a stale re-auth is rejected; group is checked BEFORE step-up", () => {
  const stale = authorizeCapability(alice, "message.redact", policy, 999);
  assert.deepEqual(stale, { allow: false, reason: "stepup_required", capability: "message.redact", maxAgeSeconds: 300 });
  // A non-member with a perfectly fresh token is STILL forbidden by group (can't step-up into a group).
  assert.equal(authorizeCapability(bob, "message.redact", policy, 0).allow, false);
  assert.equal((authorizeCapability(bob, "message.redact", policy, 0) as { reason: string }).reason, "forbidden_group");
});

test("a capability with no group and no step-up allows anyone", () => {
  const open = defaultCapabilityPolicy("admins");
  assert.deepEqual(authorizeCapability(bob, "agent.manage", open, Infinity), { allow: true });
  assert.deepEqual(authorizeCapability(bob, "webhook.create", open, Infinity), { allow: true });
});

test("defaultCapabilityPolicy: redact/downgrade default to the admin group, step-up off", () => {
  const p = defaultCapabilityPolicy("secchat-admins");
  assert.deepEqual(p["message.redact"], { group: "secchat-admins", stepUpSeconds: 0 });
  assert.deepEqual(p["marking.downgrade"], { group: "secchat-admins", stepUpSeconds: 0 });
  assert.equal(p["agent.manage"].group, "");
  assert.equal(p["webhook.create"].group, "");
  for (const cap of ["message.redact", "agent.manage", "marking.downgrade", "webhook.create"] as Capability[]) {
    assert.equal(p[cap].stepUpSeconds, 0);
  }
});

test("step-up token: mint → verify round-trips the subject with a small age; tampering/wrong-secret is rejected", async () => {
  const stepUp = makeStepUp("s3cr3t-key-for-stepup", 900);
  const token = await stepUp.mint("alice");
  const proof = await stepUp.verify(token);
  assert.ok(proof);
  assert.equal(proof!.sub, "alice");
  assert.ok(proof!.ageSeconds >= 0 && proof!.ageSeconds < 5, "a fresh token reads as ~0s old");

  // A token signed with a different secret can't be verified here.
  const other = makeStepUp("a-totally-different-secret", 900);
  assert.equal(await stepUp.verify(await other.mint("alice")), null);
  assert.equal(await stepUp.verify("not-a-jwt"), null);
});
