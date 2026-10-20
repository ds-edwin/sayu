import { documentSchema, type Workspace } from "./model.ts";

export type NodeClipboard = {
  format: "sayu-nodes";
  version: 1;
  token: string;
  nodes: Workspace["nodes"];
  edges: Workspace["edges"];
};

export function captureNodeClipboard(
  document: Workspace,
  ids: string[],
  token: string = crypto.randomUUID(),
): NodeClipboard | null {
  const chosen = new Set(ids);
  const nodes = document.nodes.filter(n => chosen.has(n.id));
  if (!nodes.length) return null;
  const present = new Set(nodes.map(n => n.id));
  return structuredClone({
    format: "sayu-nodes", version: 1, token, nodes,
    edges: document.edges.filter(e => present.has(e.source) && present.has(e.target)),
  });
}

export function parseNodeClipboard(text: string): NodeClipboard | null {
  try {
    const value = JSON.parse(text);
    if (value?.format !== "sayu-nodes" || value.version !== 1 ||
        typeof value.token !== "string" || !value.token || value.token.length > 100 ||
        !Array.isArray(value.nodes) || !value.nodes.length) return null;
    const mapIds = new Set<string>();
    for (const node of value.nodes) {
      if (typeof node?.mapId === "string") mapIds.add(node.mapId);
    }
    if (!mapIds.size) mapIds.add("clipboard-map");
    const parsed = documentSchema.safeParse({
      folders: [],
      maps: Array.from(mapIds, id => ({ id, name: "Clipboard", description: "", folderId: null })),
      nodes: value.nodes,
      edges: value.edges,
    });
    return parsed.success ? {
      format: "sayu-nodes", version: 1, token: value.token,
      nodes: parsed.data.nodes, edges: parsed.data.edges,
    } : null;
  } catch {
    return null;
  }
}

export function pasteNodeClipboard(
  document: Workspace,
  clipboard: NodeClipboard,
  targetMapId: string,
  options: {
    cut?: boolean;
    anchor?: { x: number; y: number };
    makeId?: () => string;
    now?: string;
  } = {},
) {
  if (!document.maps.some(m => m.id === targetMapId))
    throw Error("붙여넣을 맵을 찾을 수 없습니다.");
  if (!clipboard.nodes.length) throw Error("붙여넣을 노드가 없습니다.");
  const makeId = options.makeId ?? (() => crypto.randomUUID());
  const now = options.now ?? new Date().toISOString();
  const live = new Map(document.nodes.map(n => [n.id, n]));
  const originals = options.cut ? clipboard.nodes.map(snapshot => {
    const node = live.get(snapshot.id);
    if (!node || node.mapId !== snapshot.mapId || node.createdAt !== snapshot.createdAt)
      throw Error("잘라낼 노드가 삭제되거나 이동했습니다. 원본에서 다시 선택해 주세요.");
    return node;
  }) : clipboard.nodes;
  const minX = Math.min(...originals.map(n => n.position.x));
  const minY = Math.min(...originals.map(n => n.position.y));
  const maxX = Math.max(...originals.map(n => n.position.x));
  const maxY = Math.max(...originals.map(n => n.position.y));
  // Clamp the translation as a group, preserving relative node positions.
  const dx = Math.max(-100000 - minX, Math.min(100000 - maxX, (options.anchor?.x ?? minX + 45) - minX));
  const dy = Math.max(-100000 - minY, Math.min(100000 - maxY, (options.anchor?.y ?? minY + 45) - minY));
  const remap = new Map(originals.map(n => [n.id, options.cut ? n.id : makeId()]));
  const pasted = originals.map(n => ({
    ...structuredClone(n), id: remap.get(n.id)!, mapId: targetMapId,
    position: { x: n.position.x + dx, y: n.position.y + dy },
    createdAt: options.cut ? n.createdAt : now, updatedAt: now,
  }));
  const replacements = new Map(pasted.map(n => [n.id, n]));
  const nodes = options.cut
    ? document.nodes.map(n => replacements.get(n.id) ?? n)
    : [...document.nodes, ...pasted];
  const finalMaps = new Map(nodes.map(n => [n.id, n.mapId]));
  const edges = options.cut
    ? document.edges.filter(e => finalMaps.get(e.source) === finalMaps.get(e.target))
    : [...document.edges, ...clipboard.edges.map(e => ({
        ...e, id: makeId(), source: remap.get(e.source)!, target: remap.get(e.target)!,
      }))];
  const candidate = { ...document, nodes, edges };
  if (!documentSchema.safeParse(candidate).success)
    throw Error("붙여넣기 한도(노드 2,000개·연결 5,000개)를 초과하거나 유효하지 않은 내용입니다.");
  return {
    document: candidate,
    ids: pasted.map(n => n.id),
    removedEdges: options.cut ? document.edges.length - edges.length : 0,
  };
}
