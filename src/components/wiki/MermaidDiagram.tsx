"use client";

import { useEffect, useId, useMemo, useState } from "react";

interface MermaidDiagramProps {
  code: string;
}

type RenderState =
  | { status: "idle" | "loading" }
  | { status: "rendered"; svg: string }
  | { status: "error"; message: string };

// Module-level guard: initialize mermaid exactly once per page load so
// multiple diagrams don't race to clobber each other's config (W1 fix).
let mermaidInitialized = false;

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  // Stabilize the source string so the effect doesn't re-fire on every parent
  // re-render (W2 fix — .trim() returns a fresh string each call).
  const source = useMemo(() => code.trim(), [code]);
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      if (!source) {
        setRenderState({ status: "error", message: "Diagram source is empty." });
        return;
      }

      setRenderState({ status: "loading" });

      try {
        // Mermaid touches browser globals, so load it only after hydration.
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;

        // Initialize once per page — safe even with concurrent diagrams.
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "base",
            themeVariables: {
              fontFamily: "inherit",
            },
          });
          mermaidInitialized = true;
        }

        const { svg } = await mermaid.render(diagramId, source);
        if (!cancelled) {
          setRenderState({ status: "rendered", svg });
        }
      } catch (error) {
        if (!cancelled) {
          setRenderState({
            status: "error",
            message: error instanceof Error ? error.message : "Unable to render diagram.",
          });
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [diagramId, source]);

  return (
    <figure className="mermaid-container" aria-label="Mermaid diagram">
      {renderState.status === "rendered" ? (
        <div
          className="mermaid-rendered"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : (
        <pre className="mermaid-fallback">
          {renderState.status === "error"
            ? `Mermaid diagram error: ${renderState.message}`
            : source}
        </pre>
      )}
    </figure>
  );
}
