import { documentSchema, type Workspace } from "./model.ts";
export type LocalWorkspace = { document: Workspace; revision: number };
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("sayu-local-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      opening = undefined;
      reject(request.error);
    };
  }));
}
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const r = db.transaction("records").objectStore("records").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function setSetting(key: string, value: unknown) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
export async function archiveCurrentWorkspace() {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records");
    const request = store.get("workspace");
    request.onsuccess = () => {
      const current = request.result as LocalWorkspace | undefined;
      if (!current) return;
      const recovery = store.get("recovery");
      recovery.onsuccess = () => store.put([
        { date: new Date().toISOString(), document: current.document }, ...(recovery.result ?? []),
      ].slice(0, 20), "recovery");
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
export async function writeLocal(
  document: Workspace,
  expectedRevision: number,
  archive = false,
): Promise<number> {
  const parsed = documentSchema.parse(document),
    db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite"),
      store = tx.objectStore("records");
    let revision = 0,
      customError: Error | undefined;
    const r = store.get("workspace");
    r.onsuccess = () => {
      const current = r.result as LocalWorkspace | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) {
        customError = Error(
          "다른 창에서 변경했습니다. 현재 작업을 JSON으로 내보낸 후 다시 불러오세요.",
        );
        tx.abort();
        return;
      }
      revision = expectedRevision + 1;
      if (archive && current) {
        const q = store.get("recovery");
        q.onsuccess = () => {
          const previous = (q.result ?? []) as {
            date: string;
            document: Workspace;
          }[];
          store.put(
            [
              { date: new Date().toISOString(), document: current.document },
              ...previous,
            ].slice(0, 20),
            "recovery",
          );
        };
      }
      store.put({ document: parsed, revision }, "workspace");
    };
    tx.oncomplete = () => {
      window.dispatchEvent(new Event("sayu-local-saved"));
      resolve(revision);
    };
    tx.onabort = () =>
      reject(
        customError ??
          tx.error ??
          Error("기기 저장에 실패했습니다. 저장 공간을 확인하세요."),
      );
    tx.onerror = () => reject(tx.error);
  });
}
export function parsePortable(value: unknown): Workspace {
  if (value && typeof value === "object" && "format" in value) {
    const b = value as { format: unknown; version: unknown; document: unknown };
    if (
      !["sayu-workspace", "sayu-snapshot"].includes(String(b.format)) ||
      b.version !== 1
    )
      throw Error("지원하지 않는 백업 버전입니다.");
    return documentSchema.parse(b.document);
  }
  return documentSchema.parse(value);
}
export function exportFile(document: Workspace) {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            format: "sayu-workspace",
            version: 1,
            createdAt: new Date().toISOString(),
            document,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const a = window.document.createElement("a");
  a.href = url;
  a.download = `sayu-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
