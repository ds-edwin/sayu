// Deliberate emulator-only integration suite; excluded from npm test's *.test.ts glob.
// Run with GCLOUD_PROJECT=demo-sayu and FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { initializeApp, deleteApp } from "firebase/app";
import {
  initializeAuth, inMemoryPersistence, connectAuthEmulator, verifyPasswordResetCode,
  confirmPasswordReset, signInWithEmailAndPassword, signOut,
} from "firebase/auth";

const project = "demo-sayu";
const emulator = "http://127.0.0.1:9099";
const apiKey = "demo-sayu-api-key";
const output = new URL("../browser-results/", import.meta.url);
const originalFetch = globalThis.fetch;
let app;
let auth;
let actionOrigin;
const report = { projectId: project, emulator, startedAt: new Date().toISOString(), checks: [] };

before(async () => {
  assert.equal(process.env.GCLOUD_PROJECT, project, "Explicit demo-sayu project is required");
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9099", "Only the fixed local Auth emulator is permitted");
  actionOrigin = new URL(process.env.SAYU_RESET_BROWSER_ORIGIN ?? "http://127.0.0.1:4194");
  assert.equal(actionOrigin.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost"].includes(actionOrigin.hostname));
  assert.equal(actionOrigin.username + actionOrigin.password + actionOrigin.search + actionOrigin.hash, "");
  assert.equal(actionOrigin.pathname, "/");
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, emulator, "This integration suite must never contact a production endpoint");
    return originalFetch(input, init);
  };
  await json(`${emulator}/emulator/v1/projects/${project}/config`);
  app = initializeApp({ apiKey, authDomain: "demo-sayu.firebaseapp.com", projectId: project }, `sayu-reset-${randomUUID()}`);
  auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, emulator, { disableWarnings: true });
  assert.equal(auth.emulatorConfig?.host, "127.0.0.1");
  assert.equal(auth.emulatorConfig?.port, 9099);
  await mkdir(output, { recursive: true });
});

after(async () => {
  if (app) await deleteApp(app);
  globalThis.fetch = originalFetch;
  report.finishedAt = new Date().toISOString();
  if (app) await writeFile(new URL("firebase-reset-test-report.json", output), JSON.stringify(report, null, 2) + "\n");
});

async function json(url, body) {
  assert.equal(new URL(url).origin, emulator);
  const response = await fetch(url, {
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `Local Auth emulator returned HTTP ${response.status}`);
  return response.json();
}
function endpoint(action) {
  return `${emulator}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=${apiKey}`;
}
async function createSyntheticAccount() {
  const email = `reset-${randomUUID()}@example.invalid`;
  const password = `Old-${randomUUID()}-9!aA`;
  const value = await json(endpoint("signUp"), { email, password, returnSecureToken: true });
  assert.ok(value.localId && value.idToken);
  const claims = JSON.parse(Buffer.from(value.idToken.split(".")[1], "base64url").toString());
  assert.equal(claims.aud, project);
  return { email, password, uid: value.localId };
}
async function resetCode(email) {
  await json(endpoint("sendOobCode"), { requestType: "PASSWORD_RESET", email });
  // https://firebase.google.com/docs/reference/rest/auth/
  const value = await json(`${emulator}/emulator/v1/projects/${project}/oobCodes`);
  const action = value.oobCodes.findLast(item => item.email === email && item.requestType === "PASSWORD_RESET");
  assert.ok(typeof action?.oobCode === "string" && action.oobCode.length > 0, "The emulator must provide a reset action code");
  return action.oobCode;
}

test("password reset verifies code, changes the password, retains UID, and rejects old/reused credentials", async () => {
  const user = await createSyntheticAccount();
  const code = await resetCode(user.email);
  assert.equal(await verifyPasswordResetCode(auth, code), user.email);
  const nextPassword = `New-${randomUUID()}-9!aA`;
  await confirmPasswordReset(auth, code, nextPassword);
  const signedIn = await signInWithEmailAndPassword(auth, user.email, nextPassword);
  assert.equal(signedIn.user.uid, user.uid, "A password reset must preserve the account identity and its workspace UID");
  await signOut(auth);
  await assert.rejects(() => signInWithEmailAndPassword(auth, user.email, user.password), problem =>
    ["auth/wrong-password", "auth/invalid-credential"].includes(problem?.code));
  await assert.rejects(() => verifyPasswordResetCode(auth, code), problem => problem?.code === "auth/invalid-action-code");
  await assert.rejects(() => confirmPasswordReset(auth, code, `Unused-${randomUUID()}-9!aA`), problem => problem?.code === "auth/invalid-action-code");
  assert.equal((await signInWithEmailAndPassword(auth, user.email, nextPassword)).user.uid, user.uid);
  await signOut(auth);
  report.checks.push({ name: "valid code / reset / unchanged UID / old password rejected / reused code rejected", passed: true });
});

test("a separate unused action code is saved for a local browser view with an empty URL API key", async () => {
  const user = await createSyntheticAccount();
  const code = await resetCode(user.email);
  assert.equal(await verifyPasswordResetCode(auth, code), user.email);
  const url = new URL("/email-action.html", actionOrigin);
  url.searchParams.set("firebaseEmulator", "1");
  url.searchParams.set("mode", "resetPassword");
  url.searchParams.set("apiKey", "");
  url.searchParams.set("oobCode", code);
  await writeFile(new URL("firebase-reset-browser-action.json", output), JSON.stringify({
    projectId: project, emulator, actionUrl: url.href, email: user.email,
    createdAt: new Date().toISOString(), viewOnly: true,
  }, null, 2) + "\n", { mode: 0o600 });
  assert.equal(await verifyPasswordResetCode(auth, code), user.email, "Viewing the action must not consume its code");
  report.checks.push({ name: "fresh unused browser action saved with blank apiKey", passed: true });
});
