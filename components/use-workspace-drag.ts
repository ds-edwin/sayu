"use client";
import { useEffect, useRef, useState } from "react";
export type DragItem = { type: "map" | "node"; id: string; label: string };
export type DropTarget = { type: "folder" | "map"; id: string; label: string };
export function useWorkspaceDrag(onDrop: (item: DragItem, target: DropTarget) => void) {
  const [drag, setDrag] = useState<(DragItem & { x: number; y: number }) | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const latest = useRef(onDrop);
  latest.current = onDrop;
  const active = useRef<{ item: DragItem; pointerId: number; x: number; y: number; moved: boolean; canceled?: boolean } | null>(null);
  const suppressClick = useRef(false);
  const clearClick = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    function hit(item: DragItem, x: number, y: number): DropTarget | null {
      const attribute = item.type === "map" ? "data-drop-folder" : "data-drop-map";
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${attribute}]`);
      return element ? { type: item.type === "map" ? "folder" : "map", id: element.getAttribute(attribute)!, label: element.dataset.dropLabel ?? "내 맵" } : null;
    }
    const move = (event: PointerEvent) => {
      const current = active.current;
      if (!current || current.canceled || event.pointerId !== current.pointerId) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 7) return;
      current.moved = true;
      event.preventDefault();
      setDrag({ ...current.item, x: event.clientX, y: event.clientY });
      setTarget(hit(current.item, event.clientX, event.clientY));
    };
    const end = (event: PointerEvent) => {
      const current = active.current;
      if (!current || event.pointerId !== current.pointerId) return;
      active.current = null;
      setDrag(null); setTarget(null);
      if (current.moved) {
        suppressClick.current = true;
        clearTimeout(clearClick.current);
        clearClick.current = setTimeout(() => { suppressClick.current = false; }, 0);
        if (!current.canceled && event.type !== "pointercancel") {
          const destination = hit(current.item, event.clientX, event.clientY);
          if (destination) latest.current(current.item, destination);
        }
      }
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active.current) {
        // Keep the gesture until pointerup so its captured click is consumed.
        active.current.canceled = true;
        active.current.moved = true;
        setDrag(null); setTarget(null);
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", cancel);
    return () => {
      clearTimeout(clearClick.current);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", cancel);
    };
  }, []);
  function start(event: React.PointerEvent<HTMLElement>, item: DragItem) {
    if (event.button !== 0) return;
    // Touch uses the dedicated grip so scrolling an Inbox list stays natural.
    if (event.pointerType !== "mouse" && !(event.target as Element).closest(".drag-grip")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }
  function consumeClick(event: React.MouseEvent) {
    if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
  }
  return { drag, target, start, consumeClick };
}
