"use client";
import { useViewport } from "@xyflow/react";
export type PendingConnection = { id: string; type: "source" | "target" };
export default function ClickConnection({
  pending,
  cursor,
}: {
  pending: PendingConnection | null;
  cursor: { x: number; y: number } | null;
}) {
  useViewport();
  if (!pending || !cursor) return null;
  const node = document.querySelector(
    `[data-testid="rf__node-${CSS.escape(pending.id)}"]`,
  );
  const handle = node?.querySelector(
    `.react-flow__handle-${pending.type === "source" ? "right" : "left"}`,
  );
  const r = handle?.getBoundingClientRect();
  if (!r) return null;
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2,
    dx =
      Math.max(60, Math.abs(cursor.x - x) / 2) *
      (pending.type === "source" ? 1 : -1);
  return (
    <svg className="click-connection" aria-hidden="true">
      <path
        d={`M ${x} ${y} C ${x + dx} ${y}, ${cursor.x - dx} ${cursor.y}, ${cursor.x} ${cursor.y}`}
        fill="none"
        stroke="#6654d9"
        strokeWidth="2"
        strokeDasharray="6 4"
      />
      <circle cx={cursor.x} cy={cursor.y} r="4" fill="#6654d9" />
    </svg>
  );
}
