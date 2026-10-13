import { documentSchema, type Workspace } from "./model.ts";
export type Snapshot = {
  format: "sayu-snapshot";
  version: 1;
  id: string;
  parents: string[];
  createdAt: string;
  document: Workspace;
};
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const filenamePattern = new RegExp(
  `^(${uuid})(?:__(${uuid}(?:_${uuid})*))?\\.json$`,
);
export function snapshotName(id: string, parents: string[]) {
  if (parents.length > 5)
    throw Error(
      "동시에 발생한 버전이 너무 많습니다. 각 버전을 내보내고 새 작업실을 선택하세요.",
    );
  const name = id + (parents.length ? "__" + parents.join("_") : "") + ".json";
  if (!filenamePattern.test(name)) throw Error("잘못된 버전 ID입니다.");
  return name;
}
export function parseName(name: string) {
  const m = filenamePattern.exec(name);
  return m ? { id: m[1], parents: m[2]?.split("_") ?? [] } : null;
}
export function findHeads(names: string[]) {
  const records = names
    .map(parseName)
    .filter((v): v is NonNullable<typeof v> => !!v);
  const ids = new Set(records.map((r) => r.id)),
    ancestors = new Set(records.flatMap((r) => r.parents));
  if (records.some((r) => r.parents.some((p) => !ids.has(p))))
    throw Error(
      "OneDrive 버전 기록 일부가 없습니다. 파일 삭제 또는 동기화 지연을 확인하세요.",
    );
  const heads = records.filter((r) => !ancestors.has(r.id));
  if (records.length && !heads.length)
    throw Error("버전 기록이 손상되었습니다.");
  return heads;
}
export function parseSnapshot(raw: unknown, expectedId: string): Snapshot {
  const s = raw as Snapshot;
  if (
    !s ||
    s.format !== "sayu-snapshot" ||
    s.version !== 1 ||
    s.id !== expectedId ||
    !Array.isArray(s.parents)
  )
    throw Error("올바른 OneDrive 버전이 아닙니다.");
  snapshotName(s.id, s.parents);
  return { ...s, document: documentSchema.parse(s.document) };
}
export type Decision = "push" | "pull" | "same" | "conflict";
export function decideSync(
  local: string,
  base: string | undefined,
  baseId: string | undefined,
  heads: string[],
  remote?: string,
): Decision {
  if (heads.length > 1) return "conflict";
  if (!heads.length) {
    if (baseId)
      throw Error(
        "연결된 OneDrive 기록이 사라졌습니다. 새 저장소를 선택하거나 기록을 복구하세요.",
      );
    return "push";
  }
  if (remote === local) return "same";
  if (!baseId) return "conflict";
  if (heads[0] === baseId) return local === base ? "same" : "push";
  return local === base ? "pull" : "conflict";
}
