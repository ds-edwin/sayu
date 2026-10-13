import { getSetting, setSetting } from "./local-store.ts";
import { decideSync, findHeads, parseSnapshot, snapshotName, workspaceSignature, SyncConflict, type Snapshot } from "./sync-graph.ts";
import type { Workspace } from "./model.ts";

// Structural types also let the storage engine be exercised without a browser picker.
export type FolderFile = {
  kind: "file";
  name: string;
  getFile(): Promise<{ size: number; text(): Promise<string> }>;
  createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
};
export type FolderHandle = {
  kind: "directory";
  name: string;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  isSameEntry(other: FolderHandle): Promise<boolean>;
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<FolderHandle>;
  getFileHandle(name: string, options?: { create: boolean }): Promise<FolderFile>;
  values(): AsyncIterable<FolderHandle | FolderFile>;
};
export type FolderConfig = { handle: FolderHandle; key: string };
export type FolderContents = Pick<FolderHandle, "values" | "getFileHandle">;
export const folderVersions = "sayu-versions";
const permission = { mode: "readwrite" } as const;
export class FolderPermissionError extends Error {
  constructor() {
    super("폴더 접근 권한이 필요합니다. 저장소 설정에서 ‘폴더 접근 허용 · 동기화’를 눌러 주세요.");
  }
}
export function supportsLocalFolder() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
export async function chooseLocalFolder() {
  const picker = (window as typeof window & {
    showDirectoryPicker?: (options: { id: string; mode: "readwrite" }) => Promise<FolderHandle>;
  }).showDirectoryPicker;
  if (!picker) throw Error("폴더 연결은 Mac·Windows의 Chrome/Edge에서 사용할 수 있습니다. 이 브라우저에서는 JSON 파일 열기·저장을 이용하세요.");
  // The picker must run directly from a click, before any database/network work.
  const handle = await picker.call(window, { id: "sayu-workspace", mode: "readwrite" });
  const previous = await getSetting<FolderConfig>("folder-config");
  const same = previous && await handle.isSameEntry(previous.handle);
  await setSetting("folder-config", { handle, key: same ? previous.key : crypto.randomUUID() });
  await setSetting("folder-auto-sync", false);
  await setSetting("auto-sync", false);
  await setSetting("folder-last-sync", null);
}
export async function permitLocalFolder() {
  const config = await getSetting<FolderConfig>("folder-config");
  if (!config) throw Error("먼저 동기화할 폴더를 선택하세요.");
  if (await config.handle.queryPermission(permission) !== "granted" &&
      await config.handle.requestPermission(permission) !== "granted") throw new FolderPermissionError();
}
export async function disconnectLocalFolder() {
  await setSetting("folder-auto-sync", false);
  await setSetting("folder-config", null);
}
type Baseline = { id: string; document: string };
export async function syncFolderContents(
  directory: FolderContents,
  local: Workspace,
  base: Baseline | undefined,
  apply: (doc: Workspace, expected?: string) => Promise<void>,
  remember: (base: Baseline) => Promise<void>,
  resolution?: string,
) {
  async function listNames() {
    const names: string[] = [];
    for await (const entry of directory.values()) if (entry.kind === "file") names.push(entry.name);
    return names;
  }
  const heads = findHeads(await listNames());
  const remote = await Promise.all(heads.map(async h => {
    const file = await (await directory.getFileHandle(snapshotName(h.id, h.parents))).getFile();
    if (file.size > 15 * 1024 * 1024) throw Error("15MB 이하의 작업실 파일만 읽을 수 있습니다.");
    const snapshot = parseSnapshot(JSON.parse(await file.text()), h.id);
    if (snapshotName(snapshot.id, snapshot.parents) !== snapshotName(h.id, h.parents))
      throw Error("폴더의 버전 정보와 파일 이름이 다릅니다.");
    return snapshot;
  }));
  const text = JSON.stringify(local);
  let decision = decideSync(workspaceSignature(local), base ? workspaceSignature(JSON.parse(base.document)) : undefined, base?.id, heads.map(h => h.id),
    remote.length === 1 ? workspaceSignature(remote[0].document) : undefined);
  let chosen = local;
  if (resolution) {
    if (resolution !== "local") {
      const match = remote.find(r => r.id === resolution);
      if (!match) throw Error("선택한 버전이 변경되었습니다. 다시 동기화하세요.");
      chosen = match.document;
    }
    decision = "push";
  }
  if (decision === "conflict") throw new SyncConflict(remote.map(s => ({ id: s.id, date: s.createdAt, document: s.document })));
  let id = heads[0]?.id;
  if (decision === "pull") {
    chosen = remote[0].document;
    await apply(chosen, text);
  }
  if (decision === "push") {
    id = crypto.randomUUID();
    const parents = heads.map(h => h.id);
    const snapshot: Snapshot = { format: "sayu-snapshot", version: 1, id, parents, createdAt: new Date().toISOString(), document: chosen };
    const body = JSON.stringify(snapshot);
    if (new Blob([body]).size > 10 * 1024 * 1024) throw Error("폴더 저장 한도(10MB)를 초과했습니다.");
    const file = await directory.getFileHandle(snapshotName(id, parents), { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(body);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    if (chosen !== local) await apply(chosen, text);
  }
  if (!id) throw Error("폴더의 최신 버전을 확인할 수 없습니다.");
  await remember({ id, document: workspaceSignature(chosen) });
  const after = findHeads(await listNames());
  if (after.length !== 1 || after[0].id !== id)
    throw Error("다른 기기의 저장도 발견했습니다. 원본은 보관되었습니다. 다시 동기화해 버전을 선택하세요.");
  return decision === "pull" ? "폴더 변경 내용을 이 기기에 가져왔습니다." : "선택한 폴더에 저장했습니다. 클라우드 전송은 OneDrive 앱에서 확인하세요.";
}
export async function syncLocalFolder(local: Workspace, apply: (doc: Workspace, expected?: string) => Promise<void>, resolution?: string) {
  const config = await getSetting<FolderConfig>("folder-config");
  if (!config) throw Error("먼저 동기화할 폴더를 선택하세요.");
  if (await config.handle.queryPermission(permission) !== "granted") throw new FolderPermissionError();
  // Keep unrelated documents in the selected folder untouched.
  const directory = await config.handle.getDirectoryHandle(folderVersions, { create: true });
  const key = "folder-baseline:" + config.key;
  const result = await syncFolderContents(directory, local, await getSetting<Baseline>(key), apply,
    base => setSetting(key, base), resolution);
  await setSetting("folder-last-sync", new Date().toISOString());
  return result;
}
