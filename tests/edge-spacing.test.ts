import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeEndpointOffsets, edgeBendPosition, EDGE_ENDPOINT_GAP, EDGE_ENDPOINT_PADDING } from "../lib/edge-spacing.ts";

const node = (id: string, x: number, y: number) => ({ id, position: { x, y } });
const edge = (id: string, source: string, target: string) => ({ id, source, target });

test("a single connection remains centered and fan-out uses a fixed gap toward upper/lower neighbors", () => {
  const nodes = [node("center", 0, 100), node("upper", 300, 0), node("lower", 300, 250)];
  const single = edgeEndpointOffsets(nodes, [edge("only", "center", "upper")]);
  assert.deepEqual(single.get("only"), { source: 0, target: 0 });
  const result = edgeEndpointOffsets(nodes, [edge("lower", "center", "lower"), edge("upper", "center", "upper")]);
  assert.equal(result.get("lower")!.source - result.get("upper")!.source, EDGE_ENDPOINT_GAP);
  assert.deepEqual(result.get("upper"), { source: -8, target: 0 });
  assert.deepEqual(result.get("lower"), { source: 8, target: 0 });
});

test("incoming and outgoing connections occupy independent sides of the same node", () => {
  const nodes = [node("center", 200, 100), node("upper", 0, 0), node("lower", 0, 250), node("right", 400, 100)];
  const result = edgeEndpointOffsets(nodes, [edge("lower", "lower", "center"), edge("right", "center", "right"), edge("upper", "upper", "center")]);
  assert.deepEqual(result.get("upper"), { source: 0, target: -8 });
  assert.deepEqual(result.get("lower"), { source: 0, target: 8 });
  assert.deepEqual(result.get("right"), { source: 0, target: 0 });
});

test("ordering follows measured visual centers and remains deterministic after input reordering", () => {
  const nodes = [node("hub", 0, 0), node("tall", 300, 0), node("short", 300, 20), node("sameYLeft", 200, 20), node("sameYRight", 400, 20)];
  const edges = [edge("tall", "hub", "tall"), edge("z", "hub", "short"), edge("left", "hub", "sameYLeft"), edge("right", "hub", "sameYRight"), edge("a", "hub", "short")];
  const measurements = { tall: { height: 240 }, short: { height: 40 }, sameYLeft: { height: 40 }, sameYRight: { height: 40 } };
  const result = edgeEndpointOffsets(nodes, edges, measurements);
  assert.deepEqual([...result.entries()].sort(), [...edgeEndpointOffsets([...nodes].reverse(), [...edges].reverse(), measurements).entries()].sort());
  assert.deepEqual(["left", "a", "z", "right", "tall"].map(id => result.get(id)!.source), [-32, -16, 0, 16, 32]);
});

test("overflow reuses fixed-gap slots inside the node, and a taller node provides more slots", () => {
  const nodes = [node("hub", 0, 0), ...Array.from({ length: 12 }, (_, i) => node(`n${i}`, 300, i * 100))];
  const edges = nodes.slice(1).map((n, i) => edge(`e${i}`, "hub", n.id));
  const small = edgeEndpointOffsets(nodes, edges, { hub: { height: 88 } });
  const smallOffsets = edges.map(e => small.get(e.id)!.source);
  assert.deepEqual([...new Set(smallOffsets)], [-32, -16, 0, 16, 32]);
  assert.ok(smallOffsets.every(offset => Math.abs(offset) <= 88 / 2 - EDGE_ENDPOINT_PADDING));
  assert.deepEqual(smallOffsets, [...smallOffsets].sort((a, b) => a - b));
  assert.ok(new Set(smallOffsets).size < smallOffsets.length);
  const tall = edgeEndpointOffsets(nodes, edges, { hub: { height: 220 } });
  const tallOffsets = edges.map(e => tall.get(e.id)!.source);
  assert.equal(new Set(tallOffsets).size, edges.length);
  assert.ok(tallOffsets.every((offset, index) => index === 0 || offset - tallOffsets[index - 1] === EDGE_ENDPOINT_GAP));
});

test("very short nodes stay centered; missing or invalid measurements use the fallback safely", () => {
  const nodes = [node("hub", 0, 0), node("top", 300, 0), node("bottom", 300, 300)];
  const edges = [edge("top", "hub", "top"), edge("bottom", "hub", "bottom")];
  for (const height of [1, 12, 24, 30]) {
    const result = edgeEndpointOffsets(nodes, edges, { hub: { height } });
    assert.ok([...result.values()].every(offset => offset.source === 0));
  }
  const fallback = edgeEndpointOffsets(nodes, edges);
  for (const height of [0, -20, Infinity, NaN]) {
    assert.deepEqual(edgeEndpointOffsets(nodes, edges, { hub: { height } }), fallback);
  }
});

test("layout leaves graph data unchanged and ignores edges whose endpoints are hidden or absent", () => {
  const nodes = [node("__proto__", 0, 0), node("constructor", 300, 0)];
  const edges = [edge("toString", "__proto__", "constructor"), edge("hidden", "__proto__", "missing")];
  const measurements = Object.fromEntries([["__proto__", { height: 124 }], ["constructor", { height: 124 }]]);
  const before = structuredClone({ nodes, edges, measurements });
  const result = edgeEndpointOffsets(nodes, edges, measurements);
  assert.deepEqual([...result], [["toString", { source: 0, target: 0 }]]);
  assert.deepEqual({ nodes, edges, measurements }, before);
});

test("orthogonal bends keep a 16px gap for same-column neighbors above, below, and converging", () => {
  const bendX = (sourceY: number, targetY: number, source: number, target: number) =>
    20 + 160 * edgeBendPosition(0, sourceY, 200, targetY, { source, target });
  const scenarios = [
    [bendX(292, 0, -8, 0), bendX(308, 100, 8, 0)],
    [bendX(292, 400, -8, 0), bendX(308, 500, 8, 0)],
    [bendX(0, 292, 0, -8), bendX(100, 308, 0, 8)],
  ];
  for (const [first, second] of scenarios) assert.ok(Math.abs(Math.abs(first - second) - EDGE_ENDPOINT_GAP) < 1e-9);
});

test("bend spacing favors the larger endpoint offset, prefers the source on ties, and stays bounded", () => {
  assert.equal(edgeBendPosition(0, 0, 200, 100, { source: 8, target: -16 }), 0.6);
  assert.equal(edgeBendPosition(0, 0, 200, 100, { source: 8, target: -8 }), 0.45);
  assert.equal(edgeBendPosition(0, 0, 200, 100, { source: 1000, target: 0 }), 0.25);
  assert.equal(edgeBendPosition(0, 0, 200, 100, { source: -1000, target: 0 }), 0.75);
  assert.equal(edgeBendPosition(0, 0, 200, 0, { source: 16, target: 0 }), 0.5);
});

test("nearby and backward-facing connections preserve their default bend", () => {
  for (const targetX of [40, 20, 0, -100]) {
    assert.equal(edgeBendPosition(0, 0, targetX, 200, { source: 16, target: -32 }), 0.5);
  }
});
