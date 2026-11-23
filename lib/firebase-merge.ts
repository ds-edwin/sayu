import { documentSchema, syncMetadataSchema, type Workspace, type SyncStamp, type SyncClock, type SyncMetadata } from "./model.ts";

const groups = ["folders", "maps", "nodes", "edges"] as const;
type Group = typeof groups[number];
type Entity = Workspace[Group][number];
type Candidate = { value?: Entity; stamp: SyncStamp };
const seed: SyncStamp = { time: 0, counter: 0, actor: "legacy", deleted: false };
const recoveryId = "sync-recovery-map";
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => lexical(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function workspaceContentSignature(document: Workspace): string {
  return stable(Object.fromEntries(groups.map(group => [group, [...document[group]].sort((a, b) => lexical(a.id, b.id))])));
}
export function compareSyncStamps(a: SyncStamp, b: SyncStamp): number {
  return a.time - b.time || a.counter - b.counter || lexical(a.actor, b.actor) || Number(a.deleted) - Number(b.deleted);
}
function metadata(document: Workspace): SyncMetadata {
  return document.syncMeta ? syncMetadataSchema.parse(document.syncMeta) : {
    version: 1, clock: { time: 0, counter: 0 },
    entities: { folders: {}, maps: {}, nodes: {}, edges: {} },
  };
}
function getStamp(meta: SyncMetadata, group: Group, id: string): SyncStamp | undefined {
  return Object.prototype.hasOwnProperty.call(meta.entities[group], id) ? meta.entities[group][id] : undefined;
}
function maximumClock(...values: SyncClock[]): SyncClock {
  return values.reduce((a, b) => b.time > a.time || (b.time === a.time && b.counter > a.counter) ? { time: b.time, counter: b.counter } : a,
    { time: 0, counter: 0 });
}
function observedClock(...values: SyncMetadata[]): SyncClock {
  let result: SyncClock = { time: 0, counter: 0 };
  for (const meta of values) {
    result = maximumClock(result, meta.clock);
    for (const group of groups) for (const stamp of Object.values(meta.entities[group])) result = maximumClock(result, stamp);
  }
  return result;
}
function nextClock(clock: SyncClock, now: number): SyncClock {
  if (!Number.isSafeInteger(now) || now < 0) throw Error("동기화 시각이 올바르지 않습니다.");
  if (now > clock.time) return { time: now, counter: 0 };
  if (clock.counter < Number.MAX_SAFE_INTEGER) return { time: clock.time, counter: clock.counter + 1 };
  if (clock.time < Number.MAX_SAFE_INTEGER) return { time: clock.time + 1, counter: 0 };
  throw Error("동기화 시계 한도를 초과했습니다. 기존 데이터는 유지됩니다.");
}
function records(...values: SyncMetadata[]): SyncMetadata["entities"] {
  const result = Object.fromEntries(groups.map(group => [group, Object.create(null)])) as SyncMetadata["entities"];
  for (const group of groups) for (const meta of values) for (const [id, stamp] of Object.entries(meta.entities[group])) {
    if (!result[group][id] || compareSyncStamps(stamp, result[group][id]) > 0) result[group][id] = { ...stamp };
  }
  return result;
}

/** Stamp local intent without validating draft text; persistence remains the validation boundary. */
export function stampWorkspace(before: Workspace, next: Workspace, actor: string, now = Date.now()): Workspace {
  if (typeof actor !== "string" || !actor || actor.length > 128) throw Error("동기화 기기 식별자가 올바르지 않습니다.");
  if (workspaceContentSignature(before) === workspaceContentSignature(next)) return before;
  const previous = metadata(before), incoming = metadata(next);
  const entities = records(previous, incoming);
  const clock = nextClock(observedClock(previous, incoming), now);
  for (const group of groups) {
    const old = new Map<string, Entity>(before[group].map(entity => [entity.id, entity]));
    const current = new Map<string, Entity>(next[group].map(entity => [entity.id, entity]));
    for (const [id, value] of current) {
      const changed = !old.has(id) || stable(old.get(id)) !== stable(value);
      entities[group][id] = changed || entities[group][id]?.deleted
        ? { ...clock, actor, deleted: false }
        : { ...(entities[group][id] ?? seed) };
    }
    for (const id of old.keys()) if (!current.has(id)) entities[group][id] = { ...clock, actor, deleted: true };
  }
  const syncMeta = syncMetadataSchema.parse({ version: 1, clock, entities });
  return { ...next, syncMeta };
}

function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(16).padStart(8, "0");
}
function fallback(group: Group, id: string, value: Entity | undefined, prior: SyncStamp, time?: number): SyncStamp {
  const nodeTime = group === "nodes" && value && "updatedAt" in value ? Date.parse(value.updatedAt) : NaN;
  const physical = Number.isSafeInteger(nodeTime) && nodeTime >= 0 ? nodeTime : time ?? 0;
  if (!Number.isSafeInteger(physical) || physical < 0) throw Error("동기화 버전 시각이 올바르지 않습니다.");
  const clock = physical > prior.time ? { time: physical, counter: 0 } : nextClock(prior, physical);
  return { ...clock, actor: `legacy:${hash(`${group}:${id}:${stable(value ?? null)}`)}`, deleted: !value };
}
function choose(a: Candidate | undefined, b: Candidate | undefined): Candidate | undefined {
  if (!a) return b;
  if (!b) return a;
  const order = compareSyncStamps(a.stamp, b.stamp) || lexical(stable(a.value ?? null), stable(b.value ?? null));
  return order >= 0 ? a : b;
}
function candidate(group: Group, id: string, value: Entity | undefined, base: Entity | undefined,
  raw: SyncStamp | undefined, baseStamp: SyncStamp | undefined, time?: number): Candidate | undefined {
  const changed = stable(value ?? null) !== stable(base ?? null);
  const prior = baseStamp ?? seed;
  if (!value) {
    if (raw?.deleted) return { stamp: raw };
    if (raw && baseStamp && compareSyncStamps(raw, baseStamp) < 0) return { stamp: { ...raw, deleted: true } };
    if (base) return { stamp: fallback(group, id, undefined, choose({ stamp: prior }, raw ? { stamp: raw } : undefined)!.stamp, time) };
    return raw ? { stamp: { ...raw, deleted: true } } : baseStamp?.deleted ? { stamp: baseStamp } : undefined;
  }
  if (!changed) {
    if (raw?.deleted) return { stamp: raw };
    return { value, stamp: raw ?? { ...prior, deleted: false } };
  }
  // A strictly older stamp is stale history, not an unstamped new edit. In
  // particular it must never be promoted past an already-observed tombstone.
  if (raw && !raw.deleted && (!baseStamp || compareSyncStamps(raw, baseStamp) !== 0)) return { value, stamp: raw };
  const latest = choose({ stamp: prior }, raw ? { stamp: raw } : undefined)!.stamp;
  return { value, stamp: fallback(group, id, value, latest, time) };
}

/** Merge one shared baseline and two descendants; never mutates or truncates an input. */
export function mergeFirebaseWorkspaces(baseInput: Workspace, localInput: Workspace, remoteInput: Workspace,
  options: { remoteTime?: number; localTime?: number } = {}): Workspace {
  for (const time of [options.localTime, options.remoteTime])
    if (time !== undefined && (!Number.isSafeInteger(time) || time < 0)) throw Error("동기화 버전 시각이 올바르지 않습니다.");
  const base = documentSchema.parse(baseInput), local = documentSchema.parse(localInput), remote = documentSchema.parse(remoteInput);
  const bm = metadata(base), lm = metadata(local), rm = metadata(remote);
  const entities = records(bm, lm, rm);
  const merged: Workspace = { folders: [], maps: [], nodes: [], edges: [] };
  for (const group of groups) {
    const b = new Map<string, Entity>(base[group].map(value => [value.id, value]));
    const l = new Map<string, Entity>(local[group].map(value => [value.id, value]));
    const r = new Map<string, Entity>(remote[group].map(value => [value.id, value]));
    const ids = new Set([...b.keys(), ...l.keys(), ...r.keys(), ...Object.keys(entities[group])]);
    const winners: Entity[] = [];
    for (const id of [...ids].sort(lexical)) {
      const bs = getStamp(bm, group, id) ?? (b.has(id) ? seed : undefined);
      const original: Candidate | undefined = bs ? { ...(bs.deleted ? {} : { value: b.get(id) }), stamp: bs } : undefined;
      const winner = choose(original, choose(
        candidate(group, id, l.get(id), b.get(id), getStamp(lm, group, id), bs, options.localTime),
        candidate(group, id, r.get(id), b.get(id), getStamp(rm, group, id), bs, options.remoteTime),
      ));
      if (!winner) continue;
      entities[group][id] = { ...winner.stamp };
      if (!winner.stamp.deleted && winner.value) winners.push(structuredClone(winner.value));
    }
    (merged[group] as Entity[]) = winners;
  }

  // Null references keep the selected entity stamp: repairing a parent must not
  // make an unrelated node body appear newer than another device's real edit.
  const folders = new Map(merged.folders.map(folder => [folder.id, folder]));
  for (const folder of merged.folders) if (folder.parentId && !folders.has(folder.parentId)) folder.parentId = null;
  for (const start of merged.folders) {
    const chain: string[] = [];
    let id: string | null = start.id;
    while (id) {
      const cycle = chain.indexOf(id);
      if (cycle >= 0) { folders.get(chain.slice(cycle).sort(lexical)[0])!.parentId = null; break; }
      chain.push(id);
      id = folders.get(id)?.parentId ?? null;
    }
  }
  for (const map of merged.maps) if (map.folderId && !folders.has(map.folderId)) map.folderId = null;
  const mapIds = new Set(merged.maps.map(map => map.id));
  for (const node of merged.nodes) if (node.mapId && !mapIds.has(node.mapId)) node.mapId = null;
  if (!merged.maps.length) {
    const clock = nextClock(observedClock(bm, lm, rm, { version: 1, clock: { time: 0, counter: 0 }, entities }), 0);
    merged.maps.push({ id: recoveryId, name: "복구된 맵", description: "맵에서 분리된 생각은 Inbox에 보존됩니다.", folderId: null });
    entities.maps[recoveryId] = { ...clock, actor: "system:recovery", deleted: false };
  }
  const nodes = new Map(merged.nodes.map(node => [node.id, node]));
  const retained = new Map<string, Workspace["edges"][number]>();
  const removed = new Set<string>();
  function removeEdge(edge: Workspace["edges"][number], extra: SyncStamp[] = []) {
    let stamp = entities.edges[edge.id] ?? seed;
    for (const other of extra) if (compareSyncStamps(other, stamp) > 0) stamp = other;
    entities.edges[edge.id] = { ...stamp, deleted: true };
    removed.add(edge.id);
  }
  for (const edge of merged.edges) {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source || !target || source.id === target.id || !source.mapId || source.mapId !== target.mapId) {
      removeEdge(edge, [entities.nodes[edge.source], entities.nodes[edge.target]].filter((stamp): stamp is SyncStamp => !!stamp));
      continue;
    }
    const key = JSON.stringify([edge.source, edge.target]);
    const previous = retained.get(key);
    if (!previous) retained.set(key, edge);
    else {
      const order = compareSyncStamps(entities.edges[edge.id], entities.edges[previous.id]) || lexical(edge.id, previous.id);
      const winner = order > 0 ? edge : previous, loser = order > 0 ? previous : edge;
      retained.set(key, winner);
      removeEdge(loser, [entities.edges[winner.id]]);
    }
  }
  merged.edges = merged.edges.filter(edge => !removed.has(edge.id));
  merged.syncMeta = { version: 1, clock: observedClock(bm, lm, rm, { version: 1, clock: { time: 0, counter: 0 }, entities }), entities };
  return documentSchema.parse(merged);
}
