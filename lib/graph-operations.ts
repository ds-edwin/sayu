import { blankWorkspace, documentSchema, type Workspace } from "./model.ts";
export function removeMap(document: Workspace, id: string, makeId: () => string = () => crypto.randomUUID()): Workspace {
  if (!document.maps.some(m => m.id === id)) return document;
  const affected = new Set(document.nodes.filter(n => n.mapId === id).map(n => n.id));
  const maps = document.maps.filter(m => m.id !== id);
  return {
    ...document,
    maps: maps.length ? maps : [{ ...blankWorkspace().maps[0], id: makeId() }],
    nodes: document.nodes.map(n => affected.has(n.id) ? { ...n, mapId: null } : n),
    edges: document.edges.filter(e => !affected.has(e.source) && !affected.has(e.target)),
  };
}
export function copyMap(
  document: Workspace,
  id: string,
  makeId: () => string = () => crypto.randomUUID(),
  now = new Date().toISOString(),
): { document: Workspace; mapId: string } {
  const source = document.maps.find(map => map.id === id);
  if (!source) throw Error("복사할 맵을 찾을 수 없습니다.");
  const originals = document.nodes.filter(node => node.mapId === id);
  const chosen = new Set(originals.map(node => node.id));
  const connections = document.edges.filter(edge => chosen.has(edge.source) && chosen.has(edge.target));
  if (document.maps.length + 1 > 100 || document.nodes.length + originals.length > 2000 ||
      document.edges.length + connections.length > 5000)
    throw Error("맵 복사 한도(맵 100개·노드 2,000개·연결 5,000개)를 초과합니다.");

  const names = new Set(document.maps.map(map => map.name));
  const base = source.name.replace(/ \(복사(?: \d+)?\)$/u, "") || source.name;
  let name = "";
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? " (복사)" : ` (복사 ${number})`;
    let stem = "";
    for (const character of base) {
      if (stem.length + character.length > 100 - suffix.length) break;
      stem += character;
    }
    name = stem.trimEnd() + suffix;
    if (!names.has(name)) break;
  }
  const usedIds = new Set([
    ...document.folders.map(folder => folder.id), ...document.maps.map(map => map.id),
    ...document.nodes.map(node => node.id), ...document.edges.map(edge => edge.id),
  ]);
  function freshId() {
    const next = makeId();
    if (typeof next !== "string" || !next.length || next.length > 100 || usedIds.has(next))
      throw Error("맵 복사에 사용할 새 ID를 만들지 못했습니다. 다시 시도해 주세요.");
    usedIds.add(next);
    return next;
  }
  const mapId = freshId();
  const remap = new Map(originals.map(node => [node.id, freshId()]));
  const nodes = originals.map(node => ({
    ...structuredClone(node), id: remap.get(node.id)!, mapId,
    createdAt: now, updatedAt: now,
  }));
  const edges = connections.map(edge => ({
    ...edge, id: freshId(), source: remap.get(edge.source)!, target: remap.get(edge.target)!,
  }));
  const candidate: Workspace = {
    ...document,
    maps: [...document.maps, { ...source, id: mapId, name }],
    nodes: [...document.nodes, ...nodes],
    edges: [...document.edges, ...edges],
  };
  if (!documentSchema.safeParse(candidate).success)
    throw Error("맵을 복사하지 못했습니다. 작업실의 내용이 올바른지 확인해 주세요.");
  return { document: candidate, mapId };
}
export function moveMapToFolder(document: Workspace, id: string, folderId: string | null): Workspace {
  if (folderId && !document.folders.some(f => f.id === folderId)) return document;
  return { ...document, maps: document.maps.map(m => m.id === id ? { ...m, folderId } : m) };
}
export function moveInboxNode(document: Workspace, id: string, mapId: string): Workspace {
  if (!document.maps.some(m => m.id === mapId) || !document.nodes.some(n => n.id === id && n.mapId === null)) return document;
  const count = document.nodes.filter(n => n.mapId === mapId).length;
  return { ...document, nodes: document.nodes.map(n => n.id === id ? {
    ...n, mapId, position: { x: 120 + count % 3 * 290, y: 120 + Math.floor(count / 3) * 220 }, updatedAt: new Date().toISOString(),
  } : n) };
}
export function removeNodes(document: Workspace, ids: string[]): Workspace {
  const chosen = new Set(ids);
  return {
    ...document,
    nodes: document.nodes.filter((n) => !chosen.has(n.id)),
    edges: document.edges.filter(
      (e) => !chosen.has(e.source) && !chosen.has(e.target),
    ),
  };
}
export function copyNodes(
  document: Workspace,
  ids: string[],
  makeId: () => string = () => crypto.randomUUID(),
  now = new Date().toISOString(),
) {
  const remap = new Map(ids.map((id) => [id, makeId()]));
  const copies = document.nodes
    .filter((n) => remap.has(n.id))
    .map((n) => ({
      ...n,
      id: remap.get(n.id)!,
      title: (n.title + " 복사").slice(0, 200),
      position: { x: n.position.x + 45, y: n.position.y + 45 },
      createdAt: now,
      updatedAt: now,
    }));
  const edges = document.edges
    .filter((e) => remap.has(e.source) && remap.has(e.target))
    .map((e) => ({
      ...e,
      id: makeId(),
      source: remap.get(e.source)!,
      target: remap.get(e.target)!,
    }));
  return {
    document: {
      ...document,
      nodes: [...document.nodes, ...copies],
      edges: [...document.edges, ...edges],
    },
    ids: copies.map((n) => n.id),
  };
}
