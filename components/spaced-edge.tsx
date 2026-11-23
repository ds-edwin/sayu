"use client";
import { BezierEdge, SmoothStepEdge, type Edge, type EdgeProps } from "@xyflow/react";
import { edgeBendPosition } from "@/lib/edge-spacing";

export type SpacedEdge = Edge<{
  path: "default" | "smoothstep" | "step";
  sourceOffset: number;
  targetOffset: number;
}, "spaced">;

function SpacedRelationEdge({ data, ...props }: EdgeProps<SpacedEdge>) {
  const sourceOffset = data?.sourceOffset ?? 0, targetOffset = data?.targetOffset ?? 0;
  const sourceY = props.sourceY + sourceOffset, targetY = props.targetY + targetOffset;
  // Only the rendered endpoints move. The document and the central handles used
  // to create connections stay unchanged, including on existing saved maps.
  if (data?.path === "default") return <BezierEdge {...props} sourceY={sourceY} targetY={targetY} />;
  return <SmoothStepEdge {...props} sourceY={sourceY} targetY={targetY}
    pathOptions={{
      borderRadius: data?.path === "step" ? 0 : 5,
      stepPosition: edgeBendPosition(props.sourceX, sourceY, props.targetX, targetY, { source: sourceOffset, target: targetOffset }),
    }} />;
}

export const edgeTypes = { spaced: SpacedRelationEdge };
