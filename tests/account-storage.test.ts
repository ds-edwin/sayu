import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { blankWorkspace, exampleWorkspace } from "../lib/model.ts";
import {
  archiveCurrentWorkspace,
  getSetting,
  LocalRevisionConflict,
  prepareAccountWorkspace,
  readLocal,
  scopedRecoveryKey,
  setSetting,
  writeLocal,
} from "../lib/local-store.ts";

Object.assign(globalThis, { window: new EventTarget() });
const accountA = "firebase:sayu-example:account-a";
const accountB = "firebase:sayu-example:account-b";
const claimKey = "firebase-legacy-workspace-owner";

test("account storage preserves the legacy workspace and isolates account data", async t => {
  const legacy = exampleWorkspace();
  legacy.nodes[0].title = "";
  await writeLocal(legacy, 0);
  const legacyRecovery = [{ date: "2026-11-23T00:00:00.000Z", document: blankWorkspace() }];
  await setSetting("recovery", legacyRecovery);
  const originalRecord = await readLocal();

  await t.test("the first account gets a copy and originals and recovery records stay intact", async () => {
    const prepared = await prepareAccountWorkspace(accountA);
    assert.equal(prepared.revision, 1);
    assert.deepEqual(prepared.document, legacy);
    assert.deepEqual(await readLocal(), originalRecord);
    assert.deepEqual(await getSetting("recovery"), legacyRecovery);
    assert.deepEqual(await getSetting(scopedRecoveryKey(accountA)), legacyRecovery);
    assert.equal(await getSetting(claimKey), accountA);
    prepared.document.nodes[0].body = "returned-object mutation";
    assert.deepEqual((await readLocal(accountA))!.document, legacy);
  });

  await t.test("another account starts empty and cannot inherit the previous account's thoughts", async () => {
    const edit = structuredClone(legacy);
    edit.nodes[0].title = "Account A private edit";
    await writeLocal(edit, 1, false, accountA);
    const second = await prepareAccountWorkspace(accountB);
    assert.deepEqual(second.document, blankWorkspace());
    assert.equal(await getSetting(scopedRecoveryKey(accountB)), undefined);
    assert.deepEqual((await readLocal(accountA))!.document, edit);
    assert.deepEqual(await readLocal(), originalRecord);
  });

  await t.test("returning to an account keeps its edits even if guest data has changed", async () => {
    const guestEdit = structuredClone(legacy);
    guestEdit.nodes[0].title = "Later guest edit";
    await writeLocal(guestEdit, originalRecord!.revision);
    const before = await readLocal(accountA);
    assert.deepEqual(await prepareAccountWorkspace(accountA), before);
    assert.equal((await readLocal())!.document.nodes[0].title, "Later guest edit");
    assert.deepEqual(await prepareAccountWorkspace(accountB), await readLocal(accountB));
  });

  await t.test("revision checks and recovery archives use only the selected account", async () => {
    const beforeA = (await readLocal(accountA))!;
    const beforeGuest = await readLocal();
    const editB = exampleWorkspace();
    editB.nodes[0].title = "Account B private edit";
    await writeLocal(editB, 1, true, accountB);
    await assert.rejects(writeLocal(blankWorkspace(), beforeA.revision - 1, false, accountA), LocalRevisionConflict);
    assert.deepEqual(await readLocal(accountA), beforeA);
    assert.deepEqual(await readLocal(), beforeGuest);
    const recoveryB = await getSetting<{ document: unknown }[]>(scopedRecoveryKey(accountB));
    assert.deepEqual(recoveryB?.[0].document, blankWorkspace());
    await archiveCurrentWorkspace(accountA);
    assert.deepEqual((await getSetting<{ document: unknown }[]>(scopedRecoveryKey(accountA)))?.[0].document, beforeA.document);
    assert.deepEqual(await getSetting("recovery"), legacyRecovery);
    assert.deepEqual(await getSetting(scopedRecoveryKey(accountB)), recoveryB);
  });

  await t.test("simultaneous first-account preparation claims legacy data for only one account", async () => {
    await setSetting(claimKey, null);
    const original = await readLocal();
    const c = "firebase:sayu-example:concurrent-c", d = "firebase:sayu-example:concurrent-d";
    const results = await Promise.all([prepareAccountWorkspace(c), prepareAccountWorkspace(d)]);
    assert.equal(results.filter(result => result.document.nodes.length === original!.document.nodes.length).length, 1);
    assert.equal(results.filter(result => result.document.nodes.length === 0).length, 1);
    const owner = await getSetting<string>(claimKey);
    assert.ok(owner === c || owner === d);
    assert.deepEqual((await readLocal(owner))!.document, original!.document);
    assert.deepEqual(await readLocal(), original);
  });

  await t.test("invalid legacy data aborts the migration without claiming it or deleting its source", async () => {
    const before = await readLocal();
    const invalid = { ...before!, document: { ...before!.document, nodes: [{ ...before!.document.nodes[0], title: null }] } };
    await setSetting("workspace", invalid);
    await setSetting(claimKey, null);
    const scope = "firebase:sayu-example:invalid-source";
    await assert.rejects(prepareAccountWorkspace(scope));
    assert.equal(await readLocal(scope), undefined);
    assert.equal(await getSetting(claimKey), null);
    assert.deepEqual(await getSetting("workspace"), invalid);
    assert.deepEqual(await getSetting("recovery"), legacyRecovery);
    await setSetting("workspace", before);
  });

  await t.test("a pre-existing account record is never replaced while claiming legacy ownership", async () => {
    const scope = "firebase:sayu-example:already-local";
    const own = exampleWorkspace();
    own.nodes[0].title = "Existing signed-in workspace";
    await writeLocal(own, 0, false, scope);
    const before = await readLocal(scope);
    assert.deepEqual(await prepareAccountWorkspace(scope), before);
    assert.equal(await getSetting(claimKey), scope);
    assert.deepEqual((await prepareAccountWorkspace("firebase:sayu-example:after-existing")).document, blankWorkspace());
  });
});
