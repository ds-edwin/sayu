export const EDGE_ENDPOINT_GAP = 16;
export const EDGE_ENDPOINT_PADDING = 12;
export const DEFAULT_NODE_HEIGHT = 124;

type PositionedNode = {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
};
type ConnectedEdge = { readonly id: string; readonly source: string; readonly target: string };
type Measurements = Readonly<Record<string, { readonly height?: number } | undefined>>;
export type EdgeEndpointOffsets = { source: number; target: number };
type Endpoint = { edgeId: string; oppositeY: number; oppositeX: number };

/** Shift the orthogonal bend with its attachment slot when there is room ahead. */
export function edgeBendPosition(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  offsets: EdgeEndpointOffsets,
): number {
  const distance = targetX - sourceX;
  // Smooth-step paths reserve 20px at each endpoint before their central bend.
  if (distance <= 40) return 0.5;
  const portOffset = Math.abs(offsets.source) >= Math.abs(offsets.target) ? offsets.source : offsets.target;
  const laneOffset = -Math.sign(targetY - sourceY) * portOffset;
  return Math.max(0.25, Math.min(0.75, 0.5 + laneOffset / (distance - 40)));
}

function measuredHeight(id: string, measurements: Measurements): number {
  const height = measurements[id]?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? height
    : DEFAULT_NODE_HEIGHT;
}

/** Derived only for rendering: existing graph data never needs new handles or positions. */
export function edgeEndpointOffsets(
  nodes: readonly PositionedNode[],
  edges: readonly ConnectedEdge[],
  measurements: Measurements = {},
): Map<string, EdgeEndpointOffsets> {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const heights = new Map(nodes.map(node => [node.id, measuredHeight(node.id, measurements)]));
  const outgoing = new Map<string, Endpoint[]>();
  const incoming = new Map<string, Endpoint[]>();
  const offsets = new Map<string, EdgeEndpointOffsets>();

  function add(groups: Map<string, Endpoint[]>, nodeId: string, edgeId: string, opposite: PositionedNode) {
    const group = groups.get(nodeId) ?? [];
    group.push({ edgeId, oppositeY: opposite.position.y + heights.get(opposite.id)! / 2, oppositeX: opposite.position.x });
    groups.set(nodeId, group);
  }

  for (const edge of edges) {
    const source = nodeById.get(edge.source), target = nodeById.get(edge.target);
    // Hidden or missing endpoints must not consume visible attachment space.
    if (!source || !target) continue;
    offsets.set(edge.id, { source: 0, target: 0 });
    add(outgoing, source.id, edge.id, target);
    add(incoming, target.id, edge.id, source);
  }

  function distribute(groups: Map<string, Endpoint[]>, side: keyof EdgeEndpointOffsets) {
    for (const [nodeId, group] of groups) {
      group.sort((a, b) => a.oppositeY - b.oppositeY || a.oppositeX - b.oppositeX ||
        (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
      const available = Math.max(0, heights.get(nodeId)! - EDGE_ENDPOINT_PADDING * 2);
      const capacity = Math.floor(available / EDGE_ENDPOINT_GAP) + 1;
      const slots = Math.min(group.length, capacity);
      for (let index = 0; index < group.length; index++) {
        // At capacity, reuse ordered slots instead of extending beyond the card
        // or shrinking the fixed gap into an unreadable bundle of near-parallel lines.
        const slot = group.length <= slots ? index : Math.round(index * (slots - 1) / (group.length - 1));
        offsets.get(group[index].edgeId)![side] = (slot - (slots - 1) / 2) * EDGE_ENDPOINT_GAP;
      }
    }
  }

  distribute(outgoing, "source");
  distribute(incoming, "target");
  return offsets;
}
