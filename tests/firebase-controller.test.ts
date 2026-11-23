import test from "node:test";
import assert from "node:assert/strict";
import { createFirebaseSyncController, type FirebaseSyncState } from "../components/use-firebase-sync.ts";
import { blankWorkspace, type Workspace } from "../lib/model.ts";
import { FirebaseHeadConflict, type FirebaseBaseline, type FirebaseVersion } from "../lib/firebase-protocol.ts";

function workspace(name: string): Workspace {
  const document = blankWorkspace();
  document.maps[0].name = name;
  return document;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: Workspace, cloud?: Workspace) {
  let local = structuredClone(initial);
  let current = true;
  let sequence = 0;
  let baseline: FirebaseBaseline | undefined;
  let head: FirebaseVersion | null = null;
  let beforeHead: (() => Promise<void>) | undefined;
  let beforeCommit: (() => void) | undefined;
  let failBaseline = false;
  const versions = new Map<string, FirebaseVersion>();
  const archived: Workspace[] = [];
  const committedParents: Array<string | null> = [];
  const states: FirebaseSyncState[] = [];
  function publish(document: Workspace) {
    const version: FirebaseVersion = {
      id: `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      parentId: head?.id ?? null, createdAt: "2026-11-23T00:00:00.000Z",
      sha256: String(sequence).padStart(64, "0"), document: structuredClone(document),
    };
    versions.set(version.id, version);
    head = version;
    return version;
  }
  if (cloud) publish(cloud);
  const controller = createFirebaseSyncController({
    engine: {
      async getHead() {
        await beforeHead?.();
        return head ? { version: 1, headId: head.id, sha256: head.sha256, updatedAt: head.createdAt } : null;
      },
      async readVersion(id) { return structuredClone(versions.get(id)!); },
      async commit(document, expected) {
        beforeCommit?.();
        if ((head?.id ?? null) !== expected) throw new FirebaseHeadConflict(expected, head?.id ?? null, "staged-version");
        committedParents.push(expected);
        return publish(document);
      },
      watchHead() { return () => {}; },
    },
    async flush() { return structuredClone(local); },
    async replace(document, expected) {
      assert.equal(expected, JSON.stringify(local), "a pull must compare against the flushed local snapshot");
      archived.push(structuredClone(local));
      local = structuredClone(document);
    },
    async readBaseline() { return structuredClone(baseline); },
    async writeBaseline(value) {
      if (failBaseline) throw Error("기기 동기화 기록 저장 실패");
      baseline = structuredClone(value);
    },
    isCurrent: () => current,
    isOnline: () => true,
    onChange: value => states.push(value),
  });
  return {
    controller, archived, committedParents, states, versions, publish,
    get local() { return local; },
    set local(value: Workspace) { local = value; },
    get head() { return head; },
    get baseline() { return baseline; },
    set baseline(value: FirebaseBaseline | undefined) { baseline = value; },
    set current(value: boolean) { current = value; },
    set beforeHead(value: (() => Promise<void>) | undefined) { beforeHead = value; },
    set beforeCommit(value: (() => void) | undefined) { beforeCommit = value; },
    set failBaseline(value: boolean) { failBaseline = value; },
  };
}

test("first login preserves different local/cloud data until an explicit choice", async () => {
  const f = fixture(workspace("기존 PC 데이터"), workspace("iPad 데이터"));
  const originalHead = f.head!;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.controller.state.conflict?.local, f.local);
  assert.deepEqual(f.controller.state.conflict?.remote.document, originalHead.document);
  assert.equal(f.versions.size, 1);
  assert.equal(f.archived.length, 0);
  assert.equal(f.baseline, undefined);
  await f.controller.resolve("local");
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.committedParents, [originalHead.id]);
  assert.deepEqual(f.head!.document, f.local);
  assert.equal(f.versions.has(originalHead.id), true);
  assert.equal(f.baseline!.id, f.head!.id);
});

test("a fresh device pulls, then local edits commit against the last synchronized version", async () => {
  const f = fixture(blankWorkspace(), workspace("클라우드 작업실"));
  const firstHead = f.head!;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.local, firstHead.document);
  assert.deepEqual(f.archived, [blankWorkspace()]);
  assert.equal(f.committedParents.length, 0);
  f.local = workspace("PC에서 수정");
  await f.controller.sync();
  assert.deepEqual(f.committedParents, [firstHead.id]);
  assert.deepEqual(f.baseline!.document, f.local);
});

test("concurrent offline edits conflict and choosing cloud archives the local copy", async () => {
  const f = fixture(workspace("공통 원본"), workspace("공통 원본"));
  await f.controller.sync();
  f.local = workspace("PC 오프라인 편집");
  f.publish(workspace("iPad 오프라인 편집"));
  await f.controller.sync();
  assert.equal(f.controller.state.status, "conflict");
  const savedLocal = structuredClone(f.local);
  await f.controller.resolve("remote");
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.archived, [savedLocal]);
  assert.deepEqual(f.local, f.head!.document);
  assert.equal(f.committedParents.length, 0);
});

test("a stale conflict choice refreshes changed cloud/local copies without replacing either", async () => {
  const f = fixture(workspace("기존 기기"), workspace("클라우드 A"));
  await f.controller.sync();
  f.publish(workspace("클라우드 B"));
  await f.controller.resolve("local");
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.controller.state.conflict!.remote.document, workspace("클라우드 B"));
  assert.equal(f.committedParents.length, 0);
  f.local = workspace("선택하는 동안 추가 편집");
  await f.controller.resolve("remote");
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.controller.state.conflict!.local, f.local);
  assert.equal(f.archived.length, 0);
  await f.controller.resolve("remote");
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.archived, [workspace("선택하는 동안 추가 편집")]);
});

test("a CAS race becomes a reviewable conflict with the winning remote version", async () => {
  const f = fixture(workspace("공통"), workspace("공통"));
  await f.controller.sync();
  const baseline = structuredClone(f.baseline);
  f.local = workspace("내 수정");
  f.beforeCommit = () => { f.publish(workspace("다른 기기 선행 저장")); };
  await f.controller.sync();
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.local, workspace("내 수정"));
  assert.deepEqual(f.controller.state.conflict!.remote.document, workspace("다른 기기 선행 저장"));
  assert.deepEqual(f.baseline, baseline);
  assert.equal(f.archived.length, 0);
});

test("account changes during a remote read stop local replacement and baseline writes", async () => {
  const f = fixture(blankWorkspace(), workspace("이전 계정 데이터"));
  const started = deferred(), finish = deferred();
  f.beforeHead = async () => { started.resolve(); await finish.promise; };
  const syncing = f.controller.sync();
  await started.promise;
  const stateCount = f.states.length;
  f.current = false;
  finish.resolve();
  await syncing;
  assert.deepEqual(f.local, blankWorkspace());
  assert.equal(f.archived.length, 0);
  assert.equal(f.baseline, undefined);
  assert.equal(f.states.length, stateCount, "an old account cannot publish status into the new session");
});

test("editing while a cloud download is pending refuses to replace the newer local draft", async () => {
  const f = fixture(blankWorkspace(), workspace("클라우드"));
  const started = deferred(), finish = deferred();
  f.beforeHead = async () => { started.resolve(); await finish.promise; };
  const syncing = f.controller.sync();
  await started.promise;
  f.local = workspace("다운로드 도중 편집");
  finish.resolve();
  await syncing;
  assert.equal(f.controller.state.status, "error");
  assert.deepEqual(f.local, workspace("다운로드 도중 편집"));
  assert.equal(f.archived.length, 0);
  assert.equal(f.baseline, undefined);
});

test("baseline storage failure preserves a committed snapshot and retry does not republish it", async () => {
  const f = fixture(workspace("원본"), workspace("원본"));
  await f.controller.sync();
  f.local = workspace("변경");
  f.failBaseline = true;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "error");
  assert.deepEqual(f.head!.document, f.local);
  assert.equal(f.committedParents.length, 1);
  f.failBaseline = false;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.committedParents.length, 1);
  assert.equal(f.baseline!.id, f.head!.id);
});
