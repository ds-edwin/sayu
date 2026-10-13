import { Brain, Hammer, StickyNote } from "lucide-react";
import type { KnowledgeNode } from "@/lib/model";
export default function KindIcon({
  kind,
  size = 18,
}: {
  kind: KnowledgeNode["kind"];
  size?: number;
}) {
  const style = { width: size, height: size };
  return (
    <span
      className="kind-icon"
      title={kind}
      role="img"
      aria-label={kind}
      style={style}
    >
      {kind === "질문" ? (
        <b>?</b>
      ) : kind === "주장" ? (
        <b>!</b>
      ) : kind === "근거" ? (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3c-3-3-7 1-5 4-5 1-4 7 0 7h10c4 0 5-6 0-7 2-3-2-7-5-4Z M12 10v8m0-1-5 4m5-4 5 4m-5-3v4M7 21l-2-1m12 1 2-1" />
        </svg>
      ) : kind === "개념" ? (
        <Brain size={size} />
      ) : kind === "사례" ? (
        <Hammer size={size} />
      ) : (
        <StickyNote size={size} />
      )}
    </span>
  );
}
