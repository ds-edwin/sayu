"use client";
import { useState } from "react";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  Pencil,
  Trash2,
  Network,
  MoreHorizontal,
  ChevronRight,
  X,
} from "lucide-react";
import type { Workspace } from "@/lib/model";
export default function MapTree({
  doc,
  activeMap,
  onSelect,
  onCreate,
  update,
}: {
  doc: Workspace;
  activeMap: string | null;
  onSelect: (id: string) => void;
  onCreate: (folderId: string | null) => void;
  update: (fn: (d: Workspace) => Workspace) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<string | null>(null);
  function folder(parentId: string | null) {
    const name = window.prompt("새 폴더 이름");
    if (!name?.trim()) return;
    update((d) => ({
      ...d,
      folders: [
        ...d.folders,
        { id: crypto.randomUUID(), name: name.trim().slice(0, 100), parentId },
      ],
    }));
    if (parentId)
      setClosed((p) => {
        const next = new Set(p);
        next.delete(parentId);
        return next;
      });
  }
  function rename(id: string) {
    const f = doc.folders.find((f) => f.id === id)!;
    const name = window.prompt("폴더 이름", f.name);
    if (name?.trim())
      update((d) => ({
        ...d,
        folders: d.folders.map((f) =>
          f.id === id ? { ...f, name: name.trim().slice(0, 100) } : f,
        ),
      }));
  }
  function remove(id: string) {
    const f = doc.folders.find((f) => f.id === id)!;
    if (
      !window.confirm(
        "폴더만 삭제할까요? 안의 맵과 하위 폴더는 상위로 이동합니다.",
      )
    )
      return;
    update((d) => ({
      ...d,
      folders: d.folders
        .filter((f) => f.id !== id)
        .map((child) =>
          child.parentId === id ? { ...child, parentId: f.parentId } : child,
        ),
      maps: d.maps.map((m) =>
        m.folderId === id ? { ...m, folderId: f.parentId } : m,
      ),
    }));
  }
  function moveMap(id: string, folderId: string | null) {
    update((d) => ({
      ...d,
      maps: d.maps.map((m) => (m.id === id ? { ...m, folderId } : m)),
    }));
  }
  function drop(e: React.DragEvent, folderId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("application/x-thought-map");
    if (doc.maps.some((m) => m.id === id)) moveMap(id, folderId);
  }
  function branch(parentId: string | null, depth = 0): React.ReactNode {
    return (
      <div className="tree-branch">
        {doc.folders
          .filter((f) => f.parentId === parentId)
          .map((f) => {
            const collapsed = closed.has(f.id);
            return (
              <div
                key={f.id}
                className="folder-group"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => drop(e, f.id)}
              >
                <div className="folder-row">
                  <button
                    className="folder-toggle"
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setClosed((p) => {
                        const next = new Set(p);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      })
                    }
                  >
                    <ChevronRight
                      size={13}
                      className={!collapsed ? "expanded" : ""}
                    />
                    {collapsed ? (
                      <Folder size={16} />
                    ) : (
                      <FolderOpen size={16} />
                    )}
                    <span className="truncate">{f.name}</span>
                  </button>
                  <div className="folder-actions">
                    <button
                      aria-label={f.name + "에 새 맵"}
                      title="새 맵"
                      onClick={() => onCreate(f.id)}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      aria-label={f.name + "에 하위 폴더"}
                      title="하위 폴더"
                      onClick={() => folder(f.id)}
                    >
                      <FolderPlus size={14} />
                    </button>
                    <button
                      aria-label={f.name + " 이름 변경"}
                      title="이름 변경"
                      onClick={() => rename(f.id)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      aria-label={f.name + " 폴더 삭제"}
                      title="폴더 삭제"
                      onClick={() => remove(f.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {!collapsed && branch(f.id, depth + 1)}
              </div>
            );
          })}
        {doc.maps
          .filter((m) => (m.folderId ?? null) === parentId)
          .map((m) => (
            <div
              key={m.id}
              className={"map-tree-row " + (activeMap === m.id ? "active" : "")}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-thought-map", m.id);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              <button className="nav-item" onClick={() => onSelect(m.id)}>
                <Network size={16} />
                <span className="truncate">{m.name}</span>
                <span className="count">
                  {doc.nodes.filter((n) => n.mapId === m.id).length}
                </span>
              </button>
              <button
                className="map-options icon-button"
                aria-label={m.name + " 관리"}
                onClick={() => setEdit(m.id)}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          ))}
      </div>
    );
  }
  const map = doc.maps.find((m) => m.id === edit);
  function path(id: string): string {
    const f = doc.folders.find((f) => f.id === id);
    return f ? (f.parentId ? path(f.parentId) + " / " : "") + f.name : "";
  }
  return (
    <>
      <div className="maps-heading">
        <span>MY MAPS</span>
        <div>
          <button
            className="icon-button"
            title="새 폴더"
            aria-label="새 폴더"
            onClick={() => folder(null)}
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="icon-button"
            title="새 맵"
            aria-label="새 맵"
            onClick={() => onCreate(null)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <nav
        className="map-tree"
        aria-label="맵 폴더"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => drop(e, null)}
      >
        <div className="tree-root-label">
          내 맵 <small>맵을 끌어 폴더로 이동</small>
        </div>
        {branch(null)}
      </nav>
      {map && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="맵 관리"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>맵 관리</h2>
              <button
                className="icon-button"
                aria-label="맵 관리 닫기"
                onClick={() => setEdit(null)}
              >
                <X />
              </button>
            </div>
            <label className="field-label">
              맵 이름
              <input
                defaultValue={map.name}
                maxLength={100}
                onBlur={(e) => {
                  if (e.target.value.trim())
                    update((d) => ({
                      ...d,
                      maps: d.maps.map((m) =>
                        m.id === map.id
                          ? { ...m, name: e.target.value.trim() }
                          : m,
                      ),
                    }));
                }}
              />
            </label>
            <label className="field-label">
              폴더로 이동
              <select
                value={map.folderId ?? ""}
                onChange={(e) => moveMap(map.id, e.target.value || null)}
              >
                <option value="">내 맵 (최상위)</option>
                {doc.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {path(f.id)}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" onClick={() => setEdit(null)}>
              완료
            </button>
          </div>
        </div>
      )}
    </>
  );
}
