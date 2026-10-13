import type { Workspace } from "./model.ts";
type Relation = Workspace["edges"][number]["relation"];
export const relationAppearance: Record<Relation, {
  color: string; width: number; dash?: string; symbol: string; path: "smoothstep" | "default" | "step"; closed: boolean;
}> = {
  관련: { color: "#64748b", width: 2, dash: "8 6", symbol: "↔", path: "smoothstep", closed: false },
  지지: { color: "#15803d", width: 2.8, symbol: "+", path: "smoothstep", closed: true },
  반박: { color: "#dc3545", width: 2.8, dash: "3 5", symbol: "×", path: "smoothstep", closed: false },
  원인: { color: "#c46b08", width: 3.2, symbol: "→", path: "step", closed: true },
  구체화: { color: "#7c3aed", width: 2.4, dash: "12 4 2 4", symbol: "◇", path: "default", closed: true },
};
