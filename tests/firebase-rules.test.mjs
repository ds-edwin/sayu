import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// Explicit fixed emulator endpoints: this suite must never contact a real project.
const project = "demo-sayu";
const firestore = "http://127.0.0.1:8080";
const auth = "http://127.0.0.1:9099";
const documents = `${firestore}/v1/projects/${project}/databases/(default)/documents/`;
let stranger;

before(async () => {
  assert.equal(process.env.GCLOUD_PROJECT, project, "Use the demo-sayu emulator project only");
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8080");
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9099");
  stranger = await account();
});

async function account() {
  const response = await fetch(`${auth}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-sayu-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `rules-${randomUUID()}@example.test`, password: randomUUID(), returnSecureToken: true }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.ok(value.localId && value.idToken);
  const claims = JSON.parse(Buffer.from(value.idToken.split(".")[1], "base64url").toString());
  assert.equal(claims.aud, project, "Auth token must belong to the demo emulator project");
  return { uid: value.localId, token: value.idToken };
}

function field(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  throw Error("Unexpected test fixture field");
}

async function request(method, path, user, value) {
  const response = await fetch(documents + path, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    ...(value ? { body: JSON.stringify({ fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)])) }) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, value: text ? JSON.parse(text) : null };
}

function root(user) { return `users/${user.uid}/workspaces/main`; }
function versionPath(user, id) { return `${root(user)}/versions/${id}`; }
function snapshot(parentId = null) {
  const text = JSON.stringify({ folders: [], maps: [{ id: "first-map", name: "규칙 검증용", description: "", folderId: null }], nodes: [], edges: [] });
  const id = randomUUID();
  const sha256 = createHash("sha256").update(text).digest("hex");
  const createdAt = new Date().toISOString();
  const manifest = { format: "sayu-firebase-snapshot", version: 1, id, parentId, createdAt, chunkCount: 1, byteLength: Buffer.byteLength(text), sha256 };
  return { manifest, chunk: { index: 0, text }, head: { version: 1, headId: id, updatedAt: createdAt, sha256 } };
}

async function allowed(method, path, user, value) {
  const response = await request(method, path, user, value);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${response.text}`);
  return response;
}

async function denied(method, path, user, value) {
  const response = await request(method, path, user, value);
  assert.equal(response.status, 403, `${method} ${path}: ${response.status} ${response.text}`);
}

async function stage(user, value) {
  await allowed("PATCH", `${versionPath(user, value.manifest.id)}/chunks/0000`, user, value.chunk);
  await allowed("PATCH", versionPath(user, value.manifest.id), user, value.manifest);
}

test("unauthenticated and other-user reads and writes are denied", async () => {
  const user = await account();
  const value = snapshot();
  await stage(user, value);
  await allowed("PATCH", root(user), user, value.head);
  for (const caller of [undefined, stranger]) {
    for (const path of [root(user), versionPath(user, value.manifest.id), `${versionPath(user, value.manifest.id)}/chunks/0000`]) {
      await denied("GET", path, caller);
      await denied("PATCH", path, caller, path === root(user) ? value.head : path.endsWith("0000") ? value.chunk : value.manifest);
    }
    await denied("GET", `${root(user)}/versions`, caller);
  }
});

test("owner can stage chunks first, publish a complete manifest, and read its private graph", async () => {
  const user = await account();
  const value = snapshot();
  await allowed("PATCH", `${versionPath(user, value.manifest.id)}/chunks/0000`, user, value.chunk);
  assert.equal((await request("GET", versionPath(user, value.manifest.id), user)).status, 404);
  await denied("PATCH", root(user), user, value.head);
  await allowed("PATCH", versionPath(user, value.manifest.id), user, value.manifest);
  await allowed("PATCH", root(user), user, value.head);
  await allowed("GET", root(user), user);
  await allowed("GET", `${root(user)}/versions`, user);
  await allowed("GET", `${versionPath(user, value.manifest.id)}/chunks`, user);
  await allowed("GET", `${versionPath(user, value.manifest.id)}/chunks/0000`, user);
});

test("published versions and chunks are immutable and head deletion is denied", async () => {
  const user = await account();
  const value = snapshot();
  await stage(user, value);
  await allowed("PATCH", root(user), user, value.head);
  await denied("PATCH", versionPath(user, value.manifest.id), user, { ...value.manifest, byteLength: value.manifest.byteLength + 1 });
  await denied("DELETE", versionPath(user, value.manifest.id), user);
  await denied("PATCH", `${versionPath(user, value.manifest.id)}/chunks/0000`, user, { index: 0, text: "changed" });
  await denied("DELETE", `${versionPath(user, value.manifest.id)}/chunks/0000`, user);
  await denied("DELETE", root(user), user);
  await allowed("GET", root(user), user);
});

test("head changes require an existing manifest with matching hash, timestamp, and current parent", async () => {
  const user = await account();
  const first = snapshot();
  await stage(user, first);
  await denied("PATCH", root(user), user, { ...first.head, headId: randomUUID() });
  await denied("PATCH", root(user), user, { ...first.head, sha256: "0".repeat(64) });
  await denied("PATCH", root(user), user, { ...first.head, updatedAt: "2020-01-01T00:00:00.000Z" });
  await allowed("PATCH", root(user), user, first.head);
  const wrongParent = snapshot();
  await stage(user, wrongParent);
  await denied("PATCH", root(user), user, wrongParent.head);
  const second = snapshot(first.manifest.id);
  const concurrent = snapshot(first.manifest.id);
  await stage(user, second);
  await stage(user, concurrent);
  await allowed("PATCH", root(user), user, second.head);
  await denied("PATCH", root(user), user, concurrent.head);
  await denied("PATCH", root(user), user, first.head);
  await denied("PATCH", root(user), user, second.head);
  const stored = await allowed("GET", root(user), user);
  assert.equal(stored.value.fields.headId.stringValue, second.manifest.id);
});

test("manifest field shape and declared size bounds are enforced", async () => {
  const user = await account();
  for (const change of [
    { format: "other" }, { version: 2 }, { id: randomUUID() }, { parentId: "invalid" },
    { chunkCount: 0 }, { chunkCount: 165 }, { byteLength: 0 }, { byteLength: 10485761 },
    { sha256: "not-a-hash" }, { createdAt: "not-a-date" }, { extra: "not allowed" },
  ]) {
    const value = snapshot();
    await denied("PATCH", versionPath(user, value.manifest.id), user, { ...value.manifest, ...change });
  }
  const value = snapshot();
  await denied("PATCH", versionPath(user, value.manifest.id), user, { ...value.manifest, parentId: value.manifest.id });
});

test("chunk index, document key, UTF-8 size, and exact fields are enforced", async () => {
  const user = await account();
  const id = randomUUID();
  const path = `${versionPath(user, id)}/chunks/0000`;
  for (const chunk of [
    { index: -1, text: "x" }, { index: 164, text: "x" }, { index: 1, text: "x" },
    { index: 0, text: "" }, { index: 0, text: "가".repeat(87382) }, { index: 0, text: "x", extra: "not allowed" },
  ]) await denied("PATCH", path, user, chunk);
  await allowed("PATCH", path, user, { index: 0, text: "가".repeat(87381) });
  await allowed("PATCH", `${versionPath(user, id)}/chunks/0163`, user, { index: 163, text: "x" });
  await denied("PATCH", `${versionPath(user, id)}/chunks/163`, user, { index: 163, text: "x" });
  await denied("PATCH", `${versionPath(user, "not-a-uuid")}/chunks/0000`, user, { index: 0, text: "x" });
});

test("unrelated collections, workspace names, and head fields remain closed", async () => {
  const user = await account();
  const value = snapshot();
  await stage(user, value);
  await denied("PATCH", root(user), user, { ...value.head, extra: "not allowed" });
  await denied("PATCH", `users/${user.uid}/workspaces/other`, user, value.head);
  await denied("PATCH", `users/${user.uid}`, user, { name: "forbidden profile" });
  await denied("GET", "users", user);
  await denied("PATCH", "unrelated/record", user, { text: "forbidden" });
});
