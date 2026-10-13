"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import {
  ReactFlow,
  SelectionMode,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  type NodeProps,
  type Node,
  type Connection,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Brain,
  Inbox,
  Network,
  Plus,
  Search,
  X,
  ChevronRight,
  ArrowUpRight,
  Check,
  Cloud,
  FileText,
  Link2,
  Trash2,
  Download,
  LayoutGrid,
  Menu,
  BookOpen,
  Focus,
  LogOut,
  Copy,
  Undo2,
  Redo2,
} from "lucide-react";
import Editor from "./editor";
import StorageControls from "./storage-controls";
import KindIcon from "./kind-icon";
import MapTree from "./map-tree";
import { removeNodes, copyNodes } from "@/lib/graph-operations";
import ClickConnection, { type PendingConnection } from "./click-connection";
import { useWorkspace } from "./use-workspace";
import {
  colors,
  kinds,
  relations,
  exampleWorkspace,
  type KnowledgeNode,
  type Workspace as WorkspaceData,
} from "@/lib/model";
type CardNode = Node<
  {
    item: KnowledgeNode;
    onHandle: (
      id: string,
      type: "source" | "target",
      e: React.MouseEvent,
    ) => void;
    pending: PendingConnection | null;
  },
  "knowledge"
>;
function KnowledgeCard({ data, selected }: NodeProps<CardNode>) {
  const n = data.item;
  return (
    <div
      className={"knowledge-card " + (selected ? "selected" : "")}
      style={{ "--kind": colors[n.kind] } as React.CSSProperties}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={
          data.pending?.id === n.id && data.pending.type === "target"
            ? "pending-handle"
            : ""
        }
        onClick={(e) => {
          e.stopPropagation();
          data.onHandle(n.id, "target", e);
        }}
      />
      <div className="node-top">
        <KindIcon kind={n.kind} size={20} />
        <span className="node-status">{n.confidence}</span>
      </div>
      <strong>{n.title}</strong>
      <div className="node-bottom">
        {n.tags.length
          ? n.tags.map((t) => "#" + t).join(" ")
          : "생각을 이어가세요"}
        <FileText size={13} />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={
          data.pending?.id === n.id && data.pending.type === "source"
            ? "pending-handle"
            : ""
        }
        onClick={(e) => {
          e.stopPropagation();
          data.onHandle(n.id, "source", e);
        }}
      />
    </div>
  );
}
const nodeTypes = { knowledge: KnowledgeCard };
function textBody(body: string) {
  try {
    const walk = (o: unknown): string => {
      if (!o || typeof o !== "object") return "";
      const x = o as { text?: string; content?: unknown[] };
      return x.text ?? x.content?.map(walk).join(" ") ?? "";
    };
    return walk(JSON.parse(body));
  } catch {
    return "";
  }
}
function uid() {
  return crypto.randomUUID();
}
export default function Workspace() {
  const {
    document: doc,
    status,
    error,
    needsLogin,
    flush, replace,
    load,
    update,
    save,
    undo,
    redo,
    canUndo,
    canRedo,
    beginGroup,
    endGroup,
  } = useWorkspace();
  const [view, setView] = useState<"map" | "inbox">("map"),
    [mapId, setMapId] = useState("first-map"),
    [selected, setSelected] = useState<string | null>(null),
    [edgeId, setEdgeId] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [capture, setCapture] = useState(false),
    [captureTitle, setCaptureTitle] = useState(""),
    [captureBody, setCaptureBody] = useState(""),
    [newMap, setNewMap] = useState(false),
    [mapName, setMapName] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [listMode, setListMode] = useState(false),
    [kindFilter, setKindFilter] = useState("전체"),
    [target, setTarget] = useState(""),
    [relation, setRelation] = useState<(typeof relations)[number]>("관련"),
    [password, setPassword] = useState(""),
    [loginError, setLoginError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);
  const [newMapFolder, setNewMapFolder] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const flow = useRef<ReactFlowInstance<CardNode> | null>(null);
  const map = doc?.maps.find((m) => m.id === mapId) ?? doc?.maps[0];
  const activeMap = map?.id ?? mapId;
  const item = doc?.nodes.find((n) => n.id === selected);
  const selectedEdge = doc?.edges.find((e) => e.id === edgeId);
  const inbox = doc?.nodes.filter((n) => !n.mapId) ?? [];
  const mapNodes = doc?.nodes.filter((n) => n.mapId === activeMap) ?? [];
  const searchResults = useMemo(
    () =>
      doc?.nodes.filter((n) =>
        (n.title + " " + n.tags.join(" ") + " " + textBody(n.body))
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ) ?? [],
    [doc, query],
  );
  useEffect(() => {
    if (!doc) return;
    const available = new Set(doc.nodes.map((n) => n.id));
    setSelectedIds((previous) =>
      previous.every((id) => available.has(id))
        ? previous
        : previous.filter((id) => available.has(id)),
    );
  }, [doc]);
  useEffect(() => {
    const n = doc?.nodes.find((n) => n.id === selected);
    setSelectedIds(
      n &&
        (view === "inbox" ? !n.mapId : n.mapId === activeMap) &&
        (kindFilter === "전체" || n.kind === kindFilter)
        ? [n.id]
        : [],
    );
    setPending(null);
    setContext(null);
  }, [activeMap, view, kindFilter]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element)?.closest?.("dialog")) return;
      if (e.key === "Escape") {
        setPending(null);
        setContext(null);
        setSelectedIds([]);
        setCapture(false);
        setNewMap(false);
        setQuery("");
        setSelected(null);
        setEdgeId(null);
        setSidebar(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        setCapture(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function patch(id: string, values: Partial<KnowledgeNode>) {
    update(
      (d) => ({
        ...d,
        nodes: d.nodes.map((n) =>
          n.id === id
            ? { ...n, ...values, updatedAt: new Date().toISOString() }
            : n,
        ),
      }),
      "node:" + id + ":" + Object.keys(values).sort().join(","),
    );
  }
  function openNode(n: KnowledgeNode) {
    setSelected(n.id);
    setSelectedIds([n.id]);
    setEdgeId(null);
    setQuery("");
    setSidebar(false);
    setTarget("");
    if (n.mapId) {
      setMapId(n.mapId);
      setView("map");
    } else setView("inbox");
  }
  function addNode(inboxOnly = false, title = "새로운 생각", body = "") {
    const now = new Date().toISOString();
    const id = uid();
    const center = flow.current?.screenToFlowPosition({
      x: window.innerWidth * 0.48,
      y: window.innerHeight * 0.48,
    });
    const node: KnowledgeNode = {
      id,
      title: title.trim() || "새로운 생각",
      body: body
        ? JSON.stringify({
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: body }] },
            ],
          })
        : "",
      kind: "메모",
      mapId: inboxOnly ? null : activeMap,
      tags: [],
      source: "",
      confidence: "검토 전",
      position: center ?? {
        x: 200 + mapNodes.length * 30,
        y: 180 + mapNodes.length * 30,
      },
      createdAt: now,
      updatedAt: now,
    };
    update((d) => ({ ...d, nodes: [...d.nodes, node] }));
    openNode(node);
  }
  function connect(
    c: Connection | { source: string; target: string },
    r = relation,
  ) {
    if (!c.source || !c.target || c.source === c.target) return;
    update((d) =>
      d.edges.some((e) => e.source === c.source && e.target === c.target)
        ? d
        : {
            ...d,
            edges: [
              ...d.edges,
              { id: uid(), source: c.source!, target: c.target!, relation: r },
            ],
          },
    );
    setTarget("");
  }
  function deleteNodes(ids: string[]) {
    update((d) => removeNodes(d, ids));
    setSelectedIds([]);
    setSelected(null);
    setContext(null);
    setPending(null);
  }
  function removeNode(n: KnowledgeNode) {
    deleteNodes([n.id]);
  }
  function duplicateNodes(ids: string[]) {
    if (!doc) return;
    const result = copyNodes(doc, ids);
    update(() => result.document);
    setSelectedIds(result.ids);
    setSelected(result.ids.length === 1 ? result.ids[0] : null);
    setContext(null);
  }
  function handleClick(
    id: string,
    type: "source" | "target",
    e: React.MouseEvent,
  ) {
    setContext(null);
    setCursor({ x: e.clientX, y: e.clientY });
    if (!pending) {
      setPending({ id, type });
      return;
    }
    if (pending.id === id && pending.type === type) {
      setPending(null);
      return;
    }
    if (pending.id === id || pending.type === type) return;
    connect(
      {
        source: type === "target" ? pending.id : id,
        target: type === "target" ? id : pending.id,
      },
      "관련",
    );
    setPending(null);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element)?.closest?.("dialog")) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        target?.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"]',
        ) ||
        capture ||
        newMap ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        setPending(null);
        setContext(null);
      }
      if (e.key === "Delete" && selectedIds.length) {
        e.preventDefault();
        deleteNodes(selectedIds);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selectedIds, capture, newMap, undo, redo, update]);
  function exportData() {
    if (!doc) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "thought-map-backup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const nodes: CardNode[] = mapNodes
    .filter((n) => kindFilter === "전체" || n.kind === kindFilter)
    .map((n) => ({
      id: n.id,
      type: "knowledge",
      position: n.position,
      measured: measurements[n.id],
      data: { item: n, onHandle: handleClick, pending },
      selected: selectedIds.includes(n.id),
    }));
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = (doc?.edges ?? [])
    .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
    .map((e) => ({
      ...e,
      label: e.relation,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.relation === "반박" ? "#d07178" : "#a1a6bd",
      },
      style: {
        stroke:
          e.relation === "반박"
            ? "#d07178"
            : e.id === edgeId
              ? "#6254d9"
              : "#a1a6bd",
        strokeWidth: e.id === edgeId ? 2.5 : 1.5,
      },
      labelStyle: { fill: "#6b7089", fontSize: 12 },
      labelBgStyle: { fill: "#f6f7fb" },
      labelBgPadding: [7, 4] as [number, number],
    }));
  if (needsLogin)
    return (
      <main className="login-shell">
        <div className="login-card">
          <div className="logo-mark">
            <Brain />
          </div>
          <h1>사유</h1>
          <p>개인 작업실을 열려면 ChatGPT 계정으로 로그인하세요.</p>
          <a
            className="primary"
            href="/signin-with-chatgpt?return_to=%2F"
            target="_top"
          >
            ChatGPT로 로그인
          </a>
        </div>
      </main>
    );
  if (!doc)
    return (
      <main className="login-shell">
        <div className="login-card">
          <Brain size={36} />
          <h1>사유</h1>
          <p>{error || "생각 작업실을 불러오고 있습니다…"}</p>
          {error && (
            <button className="primary" onClick={load}>
              다시 연결
            </button>
          )}
        </div>
      </main>
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={"sidebar " + (sidebar ? "open" : "")}>
        <div className="brand">
          <div className="logo-mark">
            <Brain size={24} />
          </div>
          <div>
            <b>사유</b>
            <span>THOUGHT MAP</span>
          </div>
          <span className="version">v0.4</span>
        </div>
        <button
          className="primary capture-button"
          onClick={() => setCapture(true)}
        >
          <Plus size={18} /> Quick Capture
        </button>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={"nav-item " + (view === "inbox" ? "active" : "")}
          onClick={() => {
            setView("inbox");
            setSelected(null);
            setSidebar(false);
          }}
        >
          <Inbox size={18} /> Inbox{" "}
          <span className="count">{inbox.length}</span>
        </button>
        <MapTree
          doc={doc}
          activeMap={view === "map" ? activeMap : null}
          update={update}
          onCreate={(folderId) => {
            setNewMapFolder(folderId);
            setNewMap(true);
          }}
          onSelect={(id) => {
            setMapId(id);
            setView("map");
            setSelected(null);
            setSelectedIds([]);
            setEdgeId(null);
            setSidebar(false);
            setKindFilter("전체");
          }}
        />
        <div className="sidebar-note">
          <BookOpen size={19} />
          <b>생각은 연결될 때 깊어집니다.</b>
          <p>
            떠오른 생각은 Inbox에,
            <br />
            발전시킬 생각은 맵에.
          </p>
        </div>
        <div className="sidebar-bottom">
          <StorageControls flush={flush} replace={replace} />
          <button className="nav-item" onClick={exportData}>
            <Download size={17} /> JSON 내보내기
          </button>
          <div className="profile">
            <span>나</span>
            <div>
              <b>개인 작업실</b>
              <small>
                {doc.nodes.length}개의 생각 · {doc.maps.length}개의 맵
              </small>
            </div>
          </div>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="topbar">
          <div className="history-buttons">
            <button
              className="icon-button"
              aria-label="실행 취소"
              title="실행 취소 (Ctrl/⌘ Z)"
              disabled={!canUndo}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                undo();
                setPending(null);
                setContext(null);
              }}
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="다시 실행"
              title="다시 실행 (Ctrl/⌘ Shift Z)"
              disabled={!canRedo}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                redo();
                setPending(null);
                setContext(null);
              }}
            >
              <Redo2 size={17} />
            </button>
          </div>
          <button
            className="icon-button mobile-menu"
            aria-label="메뉴 열기"
            onClick={() => setSidebar(true)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            내 작업실
            <ChevronRight size={14} />
            <b>{view === "inbox" ? "Inbox" : map?.name}</b>
          </div>
          <div className="global-search">
            <Search size={17} />
            <input
              id="global-search"
              aria-label="전체 검색"
              placeholder="생각, 키워드 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>⌘ K</kbd>
            {query && (
              <button
                className="icon-button"
                aria-label="검색 닫기"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <button
            className={"save-state " + (error ? "failed" : "")}
            title="지금 저장 (Ctrl/⌘ S)"
            onClick={() => void save()}
          >
            <Cloud size={16} />
            <span>{status}</span>
          </button>
        </header>
        {query && (
          <div className="search-results">
            <div className="section-eyebrow">
              검색 결과 · {searchResults.length}
            </div>
            {searchResults.length ? (
              searchResults.map((n) => (
                <button key={n.id} onClick={() => openNode(n)}>
                  <span
                    className="type-badge"
                    style={{ color: colors[n.kind] }}
                  >
                    {n.kind}
                  </span>
                  <div>
                    <b>{n.title}</b>
                    <small>
                      {doc.maps.find((m) => m.id === n.mapId)?.name ?? "Inbox"}{" "}
                      · {textBody(n.body).slice(0, 60)}
                    </small>
                  </div>
                  <ArrowUpRight size={16} />
                </button>
              ))
            ) : (
              <p>일치하는 생각이 없습니다.</p>
            )}
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => void save()}>저장 재시도</button>
            <button onClick={exportData}>현재 작업 내보내기</button>
          </div>
        )}
        <section className="workspace-heading">
          <div>
            <div className="section-eyebrow">
              {view === "inbox" ? "CAPTURE & COLLECT" : "EXPLORE & CONNECT"}
            </div>
            <h1>
              {view === "inbox" ? "Inbox" : map?.name}
              <span className="heading-count">
                {view === "inbox" ? inbox.length : mapNodes.length}
              </span>
            </h1>
            <p>
              {view === "inbox"
                ? "일단 담아두세요. 연결은 나중에 해도 괜찮습니다."
                : map?.description}
            </p>
          </div>
          <div className="heading-actions">
            {view === "map" && (
              <button
                className="secondary view-toggle"
                aria-pressed={listMode}
                onClick={() => setListMode(!listMode)}
              >
                <LayoutGrid size={16} />
                {listMode ? "맵 보기" : "목록 보기"}
              </button>
            )}
            <button
              className="primary"
              onClick={() => (view === "inbox" ? setCapture(true) : addNode())}
            >
              <Plus size={18} />
              {view === "inbox" ? "생각 담기" : "노드 추가"}
            </button>
          </div>
        </section>
        {view === "map" && (
          <div className="map-toolbar">
            <div className="filter-tabs">
              {["전체", ...kinds].map((k) => (
                <button
                  key={k}
                  className={kindFilter === k ? "active" : ""}
                  onClick={() => setKindFilter(k)}
                >
                  {k !== "전체" && (
                    <KindIcon kind={k as KnowledgeNode["kind"]} size={15} />
                  )}{" "}
                  {k}
                </button>
              ))}
            </div>
            <span className="connection-count">
              <Link2 size={14} />
              {edges.length}개의 연결
            </span>
          </div>
        )}
        <div
          className={
            "workspace-content " + (item || selectedEdge ? "with-detail" : "")
          }
        >
          <section className="working-surface">
            {view === "inbox" ? (
              <div className="inbox-content">
                <div className="inbox-caption">
                  <span>아직 연결하지 않은 생각</span>
                  <span>{inbox.length}개</span>
                </div>
                {inbox.length === 0 ? (
                  <div className="empty">
                    <Inbox size={40} />
                    <h2>떠오른 생각을 놓치지 마세요.</h2>
                    <p>짧은 질문도, 정리되지 않은 메모도 좋습니다.</p>
                    <button
                      className="primary"
                      onClick={() => setCapture(true)}
                    >
                      <Plus size={17} />첫 생각 담기
                    </button>
                  </div>
                ) : (
                  inbox.map((n) => (
                    <div
                      className={
                        "inbox-row " + (n.id === selected ? "selected" : "")
                      }
                      key={n.id}
                    >
                      <button
                        className="inbox-open"
                        onClick={() => openNode(n)}
                      >
                        <span className="inbox-icon">
                          <FileText size={20} />
                        </span>
                        <div>
                          <strong>{n.title}</strong>
                          <p>
                            {textBody(n.body) ||
                              "내용을 더해 생각을 발전시켜 보세요."}
                          </p>
                          <small>
                            {new Date(n.createdAt).toLocaleDateString("ko-KR")}{" "}
                            · {n.kind}
                          </small>
                        </div>
                      </button>
                      <select
                        aria-label={n.title + " 맵으로 이동"}
                        value=""
                        onChange={(e) => {
                          patch(n.id, {
                            mapId: e.target.value,
                            position: {
                              x: 120,
                              y:
                                120 +
                                doc.nodes.filter(
                                  (v) => v.mapId === e.target.value,
                                ).length *
                                  70,
                            },
                          });
                          setSelected(null);
                        }}
                      >
                        <option value="" disabled>
                          맵으로 이동
                        </option>
                        {doc.maps.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))
                )}
              </div>
            ) : mapNodes.length === 0 ? (
              <div className="empty">
                <Network size={44} />
                <div className="section-eyebrow">
                  A SPACE FOR YOUR NEXT IDEA
                </div>
                <h2>하나의 질문에서 시작해 보세요.</h2>
                <p>생각을 노드로 만들고, 그 사이의 관계를 연결하세요.</p>
                <div className="empty-buttons">
                  <button className="primary" onClick={() => addNode()}>
                    <Plus size={17} />첫 노드 만들기
                  </button>
                  {doc.nodes.length === 0 && doc.maps.length === 1 && (
                    <button
                      className="secondary"
                      onClick={() => update(() => exampleWorkspace())}
                    >
                      예시 맵 둘러보기
                    </button>
                  )}
                </div>
              </div>
            ) : listMode ? (
              <div className="node-list">
                {nodes.map(({ data: { item: n } }) => (
                  <button key={n.id} onClick={() => openNode(n)}>
                    <span
                      className="type-badge"
                      style={{ color: colors[n.kind] }}
                    >
                      {n.kind}
                    </span>
                    <strong>{n.title}</strong>
                    <p>{textBody(n.body).slice(0, 100) || "내용 없음"}</p>
                    <small>
                      {n.confidence} · {n.tags.map((t) => "#" + t).join(" ")}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <ReactFlow<CardNode>
                key={activeMap}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onInit={(v) => {
                  flow.current = v;
                }}
                onNodeClick={(e, n) => {
                  if (e.ctrlKey || e.metaKey) {
                    setSelected(null);
                    setEdgeId(null);
                    return;
                  }
                  setSelected(n.id);
                  setEdgeId(null);
                  setTarget("");
                }}
                onEdgeClick={(_, e) => {
                  setEdgeId(e.id);
                  setSelected(null);
                }}
                onPaneClick={() => {
                  setPending(null);
                  setContext(null);
                  setSelectedIds([]);
                  setSelected(null);
                  setEdgeId(null);
                }}
                onNodesChange={(changes) => {
                  const selections = changes.filter((c) => c.type === "select");
                  if (selections.length)
                    setSelectedIds((previous) => {
                      const next = new Set(previous);
                      for (const c of selections) {
                        if (c.selected) next.add(c.id);
                        else next.delete(c.id);
                      }
                      return [...next];
                    });
                  for (const change of changes) {
                    if (change.type === "dimensions" && change.dimensions) {
                      const size = change.dimensions;
                      setMeasurements((previous) =>
                        previous[change.id]?.width === size.width &&
                        previous[change.id]?.height === size.height
                          ? previous
                          : { ...previous, [change.id]: size },
                      );
                    }
                  }
                  const positions = changes.filter(
                    (c) => c.type === "position",
                  );
                  if (!positions.length) return;
                  const next = applyNodeChanges(positions, nodes);
                  update((d) => ({
                    ...d,
                    nodes: d.nodes.map((n) => {
                      const moved = next.find((v) => v.id === n.id);
                      return moved ? { ...n, position: moved.position } : n;
                    }),
                  }));
                }}
                onConnect={(c) => {
                  connect(c, "관련");
                  setPending(null);
                }}
                connectOnClick={false}
                onPointerMove={(e) => {
                  if (pending) setCursor({ x: e.clientX, y: e.clientY });
                }}
                onNodeDragStart={beginGroup}
                onNodeDragStop={endGroup}
                onSelectionDragStart={beginGroup}
                onSelectionDragStop={endGroup}
                multiSelectionKeyCode={["Meta", "Control"]}
                selectionKeyCode="Shift"
                selectionMode={SelectionMode.Partial}
                onSelectionStart={() => {
                  setSelected(null);
                  setContext(null);
                  setPending(null);
                }}
                onNodeContextMenu={(e, n) => {
                  e.preventDefault();
                  const ids = selectedIds.includes(n.id) ? selectedIds : [n.id];
                  setSelectedIds(ids);
                  setContext({
                    x: Math.min(e.clientX, window.innerWidth - 210),
                    y: Math.min(e.clientY, window.innerHeight - 135),
                    ids,
                  });
                }}
                onSelectionContextMenu={(e, ns) => {
                  e.preventDefault();
                  setContext({
                    x: Math.min(e.clientX, window.innerWidth - 210),
                    y: Math.min(e.clientY, window.innerHeight - 135),
                    ids: ns.map((n) => n.id),
                  });
                }}
                isValidConnection={(c) =>
                  c.source !== c.target &&
                  !doc.edges.some(
                    (e) => e.source === c.source && e.target === c.target,
                  )
                }
                fitView
                fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
                minZoom={0.15}
                maxZoom={2}
                deleteKeyCode={null}
                proOptions={{ hideAttribution: false }}
              >
                <ClickConnection pending={pending} cursor={cursor} />
                <Background gap={22} size={1} color="#dce0ec" />
                <Controls showInteractive={false} />
                <MiniMap
                  nodeColor={(n) => colors[(n.data.item as KnowledgeNode).kind]}
                  maskColor="rgba(245,247,252,.7)"
                  pannable
                  zoomable
                />
                <div className="canvas-hint">
                  <span>
                    {pending
                      ? "다른 연결점을 클릭 · Esc로 취소"
                      : selectedIds.length > 1
                        ? `${selectedIds.length}개 선택 · Delete로 삭제`
                        : "Ctrl/⌘ 클릭 · Shift 드래그로 다중 선택"}
                  </span>
                  <i /> 연결점 클릭 또는 드래그
                </div>
              </ReactFlow>
            )}
          </section>
          {item && (
            <aside className="detail-panel" aria-label="노드 상세">
              <div className="detail-top">
                <span>
                  <FileText size={16} /> NODE DETAIL
                </span>
                <button
                  className="icon-button"
                  aria-label="상세 닫기"
                  onClick={() => setSelected(null)}
                >
                  <X size={19} />
                </button>
              </div>
              <div className="detail-scroll">
                <div className="detail-type-row">
                  <select
                    aria-label="노드 유형"
                    style={{ color: colors[item.kind] }}
                    value={item.kind}
                    onChange={(e) =>
                      patch(item.id, {
                        kind: e.target.value as KnowledgeNode["kind"],
                      })
                    }
                  >
                    {kinds.map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                  <select
                    aria-label="정리 상태"
                    value={item.confidence}
                    onChange={(e) =>
                      patch(item.id, {
                        confidence: e.target
                          .value as KnowledgeNode["confidence"],
                      })
                    }
                  >
                    {["검토 전", "탐색 중", "정리됨"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <textarea
                  className="node-title-input"
                  aria-label="노드 제목"
                  value={item.title}
                  maxLength={200}
                  rows={2}
                  onChange={(e) => patch(item.id, { title: e.target.value })}
                  onBlur={() => {
                    if (!item.title.trim())
                      patch(item.id, { title: "제목 없는 생각" });
                  }}
                />
                <div className="detail-meta">
                  {new Date(item.createdAt).toLocaleDateString("ko-KR")} 작성
                </div>
                <div className="detail-section-label">나의 생각</div>
                <Editor
                  key={item.id}
                  value={item.body}
                  onChange={(body) => patch(item.id, { body })}
                />
                <label className="field-label">
                  태그{" "}
                  <input
                    aria-label="태그"
                    placeholder="예: 경제, 기술, 역사 (쉼표 구분)"
                    key={"tags" + item.id}
                    defaultValue={item.tags.join(", ")}
                    onBlur={(e) =>
                      patch(item.id, {
                        tags: e.target.value
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean)
                          .slice(0, 20),
                      })
                    }
                  />
                </label>
                <label className="field-label">
                  출처{" "}
                  <input
                    aria-label="출처 URL"
                    placeholder="https://…"
                    key={"source" + item.id}
                    defaultValue={item.source}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && !/^https?:\/\/[^\s]+$/.test(v)) {
                        e.target.setCustomValidity(
                          "http 또는 https 주소를 입력하세요.",
                        );
                        e.target.reportValidity();
                      } else {
                        e.target.setCustomValidity("");
                        patch(item.id, { source: v });
                      }
                    }}
                  />
                </label>
                <label className="field-label">
                  위치
                  <select
                    aria-label="노드 위치"
                    value={item.mapId ?? ""}
                    onChange={(e) => {
                      const newId = e.target.value || null;
                      update((d) => ({
                        ...d,
                        nodes: d.nodes.map((n) =>
                          n.id === item.id ? { ...n, mapId: newId } : n,
                        ),
                        edges: d.edges.filter(
                          (edge) =>
                            edge.source !== item.id && edge.target !== item.id,
                        ),
                      }));
                      if (newId) {
                        setMapId(newId);
                        setView("map");
                      } else setView("inbox");
                    }}
                  >
                    <option value="">Inbox</option>
                    {doc.maps.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="detail-section-label connections-label">
                  연결된 생각{" "}
                  <span>
                    {
                      doc.edges.filter(
                        (e) => e.source === item.id || e.target === item.id,
                      ).length
                    }
                  </span>
                </div>
                {doc.edges
                  .filter((e) => e.source === item.id || e.target === item.id)
                  .map((e) => (
                    <button
                      className="related-node"
                      key={e.id}
                      onClick={() => {
                        setEdgeId(e.id);
                        setSelected(null);
                      }}
                    >
                      <Link2 size={14} />
                      <span>
                        {
                          doc.nodes.find(
                            (n) =>
                              n.id ===
                              (e.source === item.id ? e.target : e.source),
                          )?.title
                        }
                      </span>
                      <small>{e.relation}</small>
                    </button>
                  ))}
                {item.mapId && (
                  <div className="connect-form">
                    <select
                      aria-label="연결 대상"
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      <option value="">연결할 노드 선택</option>
                      {doc.nodes
                        .filter(
                          (n) => n.mapId === item.mapId && n.id !== item.id,
                        )
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.title}
                          </option>
                        ))}
                    </select>
                    <div>
                      <select
                        aria-label="연결 관계"
                        value={relation}
                        onChange={(e) =>
                          setRelation(e.target.value as typeof relation)
                        }
                      >
                        {relations.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                      <button
                        className="secondary"
                        disabled={!target}
                        onClick={() => connect({ source: item.id, target })}
                      >
                        <Link2 size={15} />
                        연결
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="detail-footer">
                <button
                  className="danger icon-button"
                  aria-label="노드 삭제"
                  onClick={() => removeNode(item)}
                >
                  <Trash2 size={18} />
                </button>
                <button className="primary" onClick={() => void save()}>
                  <Check size={16} />
                  지금 저장
                </button>
              </div>
            </aside>
          )}
          {selectedEdge && (
            <aside className="detail-panel edge-panel" aria-label="연결 상세">
              <div className="detail-top">
                <span>
                  <Link2 size={16} /> EDGE DETAIL
                </span>
                <button
                  className="icon-button"
                  aria-label="상세 닫기"
                  onClick={() => setEdgeId(null)}
                >
                  <X size={19} />
                </button>
              </div>
              <div className="detail-scroll">
                <h2>생각 사이의 관계</h2>
                <p className="edge-endpoint">
                  {doc.nodes.find((n) => n.id === selectedEdge.source)?.title}
                </p>
                <label className="field-label">
                  관계 유형
                  <select
                    aria-label="관계 유형"
                    value={selectedEdge.relation}
                    onChange={(e) =>
                      update((d) => ({
                        ...d,
                        edges: d.edges.map((v) =>
                          v.id === edgeId
                            ? {
                                ...v,
                                relation: e.target.value as typeof relation,
                              }
                            : v,
                        ),
                      }))
                    }
                  >
                    {relations.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <p className="edge-endpoint">
                  {doc.nodes.find((n) => n.id === selectedEdge.target)?.title}
                </p>
                <p className="muted">
                  연결 방향은 위 노드에서 아래 노드로 향합니다.
                </p>
                <button
                  className="secondary danger"
                  onClick={() => {
                    update((d) => ({
                      ...d,
                      edges: d.edges.filter((e) => e.id !== edgeId),
                    }));
                    setEdgeId(null);
                  }}
                >
                  <Trash2 size={16} />
                  연결 삭제
                </button>
              </div>
            </aside>
          )}
        </div>
        <footer className="workspace-footer">
          <span>
            <span className="tiny-square" /> 개인 사고·지식 관리
          </span>
          <span>
            {doc.nodes.length} nodes / {doc.edges.length} connections
          </span>
          <button onClick={() => setCapture(true)}>
            <Plus size={16} /> 빠르게 담기
          </button>
        </footer>
      </main>
      {context && (
        <>
          <div
            className="context-scrim"
            onClick={() => setContext(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContext(null);
            }}
          />
          <div
            className="node-context-menu"
            role="menu"
            style={{ left: context.x, top: context.y }}
          >
            <small>{context.ids.length}개 노드</small>
            <button role="menuitem" onClick={() => duplicateNodes(context.ids)}>
              <Copy size={16} />
              복사
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => deleteNodes(context.ids)}
            >
              <Trash2 size={16} />
              삭제 <kbd>Delete</kbd>
            </button>
          </div>
        </>
      )}
      {capture && (
        <div className="modal-backdrop" onClick={() => setCapture(false)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-heading"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (!captureTitle.trim()) return;
              addNode(true, captureTitle, captureBody);
              setCaptureTitle("");
              setCaptureBody("");
              setCapture(false);
            }}
          >
            <div className="modal-heading">
              <div>
                <div className="section-eyebrow">QUICK CAPTURE</div>
                <h2 id="capture-heading">지금 떠오른 생각</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="닫기"
                onClick={() => setCapture(false)}
              >
                <X />
              </button>
            </div>
            <label className="field-label">
              제목
              <input
                autoFocus
                aria-label="캡처 제목"
                placeholder="어떤 생각이 떠올랐나요?"
                required
                maxLength={200}
                value={captureTitle}
                onChange={(e) => setCaptureTitle(e.target.value)}
              />
            </label>
            <label className="field-label">
              메모 <span>(선택)</span>
              <textarea
                aria-label="캡처 메모"
                placeholder="맥락을 짧게 남겨두세요…"
                rows={5}
                maxLength={50000}
                value={captureBody}
                onChange={(e) => setCaptureBody(e.target.value)}
              />
            </label>
            <div className="modal-footer">
              <span>
                <Inbox size={16} /> Inbox에 담깁니다
              </span>
              <button className="primary" disabled={!captureTitle.trim()}>
                생각 담기
              </button>
            </div>
          </form>
        </div>
      )}
      {newMap && (
        <div className="modal-backdrop" onClick={() => setNewMap(false)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="map-heading"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (!mapName.trim()) return;
              const id = uid();
              update((d) => ({
                ...d,
                maps: [
                  ...d.maps,
                  {
                    id,
                    folderId: newMapFolder,
                    name: mapName.trim(),
                    description: "질문과 근거를 연결하는 나만의 탐구 공간",
                  },
                ],
              }));
              setMapId(id);
              setView("map");
              setSelected(null);
              setNewMap(false);
              setMapName("");
              setSidebar(false);
            }}
          >
            <div className="modal-heading">
              <h2 id="map-heading">새로운 맵</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="닫기"
                onClick={() => setNewMap(false)}
              >
                <X />
              </button>
            </div>
            <label className="field-label">
              맵 이름
              <input
                autoFocus
                aria-label="맵 이름"
                value={mapName}
                maxLength={100}
                onChange={(e) => setMapName(e.target.value)}
                required
                placeholder="탐구하고 싶은 주제"
              />
            </label>
            <button className="primary" disabled={!mapName.trim()}>
              맵 만들기
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
