"use client";

import { useEffect, useId, useState } from "react";

interface MermaidDiagramProps {
  code: string;
}

type RenderState =
  | { status: "idle" | "loading" }
  | { status: "rendered"; svg: string }
  | { status: "error"; message: string };

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const source = code.trim();
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

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            fontFamily: "inherit",
          },
        });

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
