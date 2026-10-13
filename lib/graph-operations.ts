import type { Workspace } from "./model";
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
