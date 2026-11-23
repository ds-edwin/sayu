import test from "node:test";
import assert from "node:assert/strict";
import { parseEmailAction, type EmailActionMode } from "../lib/email-action.ts";

test("password reset links work with empty, absent, or unrelated URL API keys", () => {
  for (const extra of ["", "&apiKey=", "&apiKey=another-project-key", "&apiKey=one&apiKey=two"]) {
    assert.deepEqual(parseEmailAction(`?mode=resetPassword&oobCode=opaque-code${extra}`), {
      mode: "resetPassword", code: "opaque-code",
    });
  }
});

test("supported Firebase email operations retain their explicit mode", () => {
  const modes: EmailActionMode[] = ["resetPassword", "verifyEmail", "recoverEmail", "verifyAndChangeEmail"];
  for (const mode of modes)
    assert.deepEqual(parseEmailAction(`mode=${mode}&oobCode=action-code`), { mode, code: "action-code" });
});

test("URL decoding preserves opaque codes without trimming or treating encoded delimiters as parameters", () => {
  const code = "opaque+code/with=padding&mode=ignored";
  assert.deepEqual(parseEmailAction(`?mode=resetPassword&oobCode=${encodeURIComponent(code)}`), {
    mode: "resetPassword", code,
  });
  assert.equal(parseEmailAction("?mode=resetPassword&oobCode=%20opaque%20").code, " opaque ");
});

test("unsupported, missing, empty and duplicate modes are rejected", () => {
  assert.throws(() => parseEmailAction("?mode=signIn&oobCode=code"), /지원하지 않는/);
  assert.throws(() => parseEmailAction("?mode=ResetPassword&oobCode=code"), /지원하지 않는/);
  for (const query of ["", "?oobCode=code", "?mode=&oobCode=code"])
    assert.throws(() => parseEmailAction(query), /작업 정보가 없습니다/);
  for (const query of [
    "?mode=resetPassword&mode=resetPassword&oobCode=code",
    "?mode=resetPassword&%6Dode=verifyEmail&oobCode=code",
  ]) assert.throws(() => parseEmailAction(query), /중복/);
});

test("missing, empty and duplicate action codes are rejected, including encoded duplicate keys", () => {
  for (const query of ["?mode=resetPassword", "?mode=resetPassword&oobCode=", "?mode=resetPassword&oobCode=%20%20"])
    assert.throws(() => parseEmailAction(query), /확인 코드가 없습니다/);
  for (const query of [
    "?mode=resetPassword&oobCode=first&oobCode=second",
    "?mode=resetPassword&oobCode=first&oob%43ode=first",
  ]) assert.throws(() => parseEmailAction(query), /중복/);
  assert.throws(() => parseEmailAction("?mode=resetPassword&code=oauth-code"), /확인 코드가 없습니다/);
});

test("code length is bounded after decoding and malformed codes are rejected", () => {
  assert.equal(parseEmailAction(`?mode=resetPassword&oobCode=${"x".repeat(8192)}`).code.length, 8192);
  assert.throws(() => parseEmailAction(`?mode=resetPassword&oobCode=${"x".repeat(8193)}`), /확인 코드가 올바르지/);
  assert.throws(() => parseEmailAction("?mode=resetPassword&oobCode=a%00b"), /확인 코드가 올바르지/);
  assert.throws(() => parseEmailAction("?mode=resetPassword&oobCode=a%0Ab"), /확인 코드가 올바르지/);
});

test("malformed URL input fails with a Korean link error instead of silent decoding", () => {
  for (const query of [
    "?mode=resetPassword&oobCode=%", "?mode=resetPassword&oobCode=%ZZ",
    "?mode=resetPassword&oobCode=%E0%A4%A", "?mode=resetPassword&oobCode=%C0%AF",
  ]) assert.throws(() => parseEmailAction(query), /주소가 손상/);
  for (const query of [
    "https://evil.example/?mode=resetPassword&oobCode=code",
    "?mode=resetPassword&oobCode=code#fragment", "x".repeat(65537),
    null, undefined, 42, {},
  ]) assert.throws(() => parseEmailAction(query as string), /링크의 형식/);
});

test("link API keys and external continuation targets cannot configure services or trigger requests", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw Error("Parsing must not use the network"); });
  // Re-import in this test to cover both module initialization and parsing.
  const isolated = await import(new URL(`../lib/email-action.ts?test=no-side-effects`, import.meta.url).href);
  const action = isolated.parseEmailAction(
    "?mode=resetPassword&oobCode=code&apiKey=untrusted&continueUrl=https%3A%2F%2Fevil.example%2F&lang=en",
  );
  assert.deepEqual(action, { mode: "resetPassword", code: "code" });
  assert.deepEqual(Object.keys(action).sort(), ["code", "mode"]);
  assert.equal(fetch.mock.callCount(), 0);
});
