import { blankWorkspace, type Workspace } from "./model.ts";
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
