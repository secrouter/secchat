// Unit tests for the pure DLP scanner (src/dlp/policy.ts) — the rule matching, the three modes,
// the content-free result (names only), and fail-closed config parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DLP_RULES, DlpPolicy, parseDlpRules } from "../src/dlp/policy.ts";

test("default rules catch unambiguous PII + control markings, not ordinary text", () => {
  const p = new DlpPolicy("flag", [...DEFAULT_DLP_RULES]);
  assert.deepEqual(p.scan("my ssn is 123-45-6789 ok"), ["us-ssn"]);
  assert.deepEqual(p.scan("card 4111 1111 1111 1111 here"), ["credit-card"]);
  assert.deepEqual(p.scan("this is marked NOFORN"), ["control-marking"]);
  // Ordinary discussion — including the bare word "CUI" — must NOT trip a rule.
  assert.deepEqual(p.scan("let's discuss the CUI handling policy"), []);
  assert.deepEqual(p.scan("hello from a test"), []);
});

test("scan returns rule NAMES only — never the matched content", () => {
  const p = new DlpPolicy("flag", [...DEFAULT_DLP_RULES]);
  const hits = p.scan("ssn 123-45-6789");
  assert.deepEqual(hits, ["us-ssn"]);
  assert.ok(!hits.join(" ").includes("123-45-6789"));
});

test("off mode never scans; enabled reflects the mode", () => {
  const off = new DlpPolicy("off", [...DEFAULT_DLP_RULES]);
  assert.equal(off.enabled, false);
  assert.deepEqual(off.scan("123-45-6789"), []);
  assert.equal(new DlpPolicy("flag", []).enabled, true);
  assert.equal(new DlpPolicy("block", []).enabled, true);
});

test("a custom rule set is honored; multiple rules report in order", () => {
  const p = new DlpPolicy("flag", [
    { name: "secret-word", pattern: "hunter2" },
    { name: "digits", pattern: "\\d{4}" },
  ]);
  assert.deepEqual(p.scan("pw hunter2 pin 4242"), ["secret-word", "digits"]);
  assert.deepEqual(p.scan("nothing here"), []);
});

test("construction fails CLOSED on a bad mode or a malformed rule pattern", () => {
  assert.throws(() => new DlpPolicy("noisy" as never, []), /invalid mode/);
  assert.throws(() => new DlpPolicy("flag", [{ name: "bad", pattern: "(" }]), /invalid pattern/);
});

test("parseDlpRules: defaults when unset, parses JSON, fails closed on garbage", () => {
  assert.deepEqual(parseDlpRules(undefined), [...DEFAULT_DLP_RULES]);
  assert.deepEqual(parseDlpRules('[{"name":"x","pattern":"y"}]'), [{ name: "x", pattern: "y" }]);
  assert.throws(() => parseDlpRules("{not json"), /not valid JSON/);
  assert.throws(() => parseDlpRules('{"name":"x"}'), /must be a JSON array/);
  assert.throws(() => parseDlpRules('[{"name":"x"}]'), /needs string "name" and "pattern"/);
});
