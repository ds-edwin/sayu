type Key = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean };
export function clipboardShortcut(event: Key): "copy" | "cut" | "paste" | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return null;
  const key = event.key.toLowerCase();
  const commands = { c: "copy", x: "cut", v: "paste" } as const;
  if (key === "c" || key === "x" || key === "v") return commands[key];
  // Fall back to the physical key for Korean/Unidentified keys, not Latin layouts.
  if (/^[a-z]$/.test(key)) return null;
  return event.code === "KeyC" ? "copy" : event.code === "KeyX" ? "cut" : event.code === "KeyV" ? "paste" : null;
}
