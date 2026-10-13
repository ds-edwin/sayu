import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankWorkspace, exampleWorkspace, type Workspace } from "../lib/model.ts";
import { syncFolderContents, type FolderContents, type FolderFile } from "../lib/local-folder.ts";
import { findHeads, SyncConflict } from "../lib/sync-graph.ts";

// Use real disk reads and writes; only the browser's permission/picker is outside this adapter.
async function diskFolder() {
  const path = await mkdtemp(join(tmpdir(), "sayu-folder-test-"));
  const file = (name: string): FolderFile => ({
    kind: "file", name,
    async getFile() {
      const bytes = await readFile(join(path, name));
      return { size: bytes.length, text: async () => bytes.toString("utf8") };
    },
    async createWritable() {
      let contents = "";
      return { write: async value => { contents = value; }, close: async () => { await writeFile(join(path, name), contents); }, abort: async () => {} };
    },
  });
  const handle = {
    async *values() { for (const name of await readdir(path)) yield file(name); },
    async getFileHandle(name: string) { return file(name); },
  };
  return { path, handle };
}
function device(initial: Workspace) {
  let document = initial;
  let base: { id: string; document: string } | undefined;
  return {
    get document() { return document; },
    get base() { return base; },
    edit(next: Workspace) { document = next; },
    sync(handle: FolderContents, resolution?: string) {
      return syncFolderContents(handle, document, base, async (next, expected) => {
        assert.equal(JSON.stringify(document), expected);
        document = next;
      }, async next => { base = next; }, resolution);
    },
  };
}
test("folder writes reach disk, another device pulls changes, unrelated files remain intact", async () => {
  const { path, handle } = await diskFolder();
  await writeFile(join(path, "notes.json"), "private unrelated document");
  const initial = blankWorkspace(), a = device(initial), b = device(initial);
  await a.sync(handle);
  await b.sync(handle);
  const edited = exampleWorkspace();
  a.edit(edited);
  await a.sync(handle);
  await b.sync(handle);
  assert.deepEqual(b.document, edited);
  assert.equal(await readFile(join(path, "notes.json"), "utf8"), "private unrelated document");
  assert.equal((await readdir(path)).length, 3);
  assert.equal(findHeads(await readdir(path)).length, 1);
});
test("initial differences and concurrent edits require selection and preserve every original", async () => {
  const { path, handle } = await diskFolder();
  const initial = blankWorkspace(), a = device(initial), b = device(exampleWorkspace());
  await a.sync(handle);
  await assert.rejects(b.sync(handle), SyncConflict);
  assert.equal((await readdir(path)).length, 1);
  await b.sync(handle, "local");
  await a.sync(handle);
  const known = await readdir(path);
  const original = await Promise.all(known.map(name => readFile(join(path, name), "utf8")));
  const docA = structuredClone(a.document), docB = structuredClone(b.document);
  docA.nodes[0].title = "Mac edit";
  docB.nodes[0].title = "Windows edit";
  a.edit(docA); b.edit(docB);
  await Promise.allSettled([a.sync(handle), b.sync(handle)]);
  const heads = findHeads(await readdir(path));
  assert.equal(heads.length, 2);
  await assert.rejects(a.sync(handle), SyncConflict);
  await a.sync(handle, "local");
  await b.sync(handle);
  assert.deepEqual(b.document, docA);
  assert.deepEqual(await Promise.all(known.map(name => readFile(join(path, name), "utf8"))), original);
  assert.equal((await readdir(path)).length, 5);
});
test("deleted history and malformed snapshots stop sync without replacing data", async () => {
  const { path, handle } = await diskFolder();
  const a = device(blankWorkspace());
  await a.sync(handle);
  const [name] = await readdir(path);
  const document = a.document;
  await writeFile(join(path, name), "{broken");
  await assert.rejects(a.sync(handle));
  assert.equal(a.document, document);
  assert.equal((await readdir(path)).length, 1);
  const empty = await diskFolder();
  await assert.rejects(a.sync(empty.handle), /기록이 사라졌습니다/);
  assert.equal((await readdir(empty.path)).length, 0);
});
