"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewTabsProps {
  targetTextareaId: string;
}

export function MarkdownPreviewTabs({ targetTextareaId }: MarkdownPreviewTabsProps) {
  const [activeTab, setActiveTab] = useState<"write" | "preview">("write");
  const [content, setContent] = useState("");

  useEffect(() => {
    const textarea = document.getElementById(targetTextareaId) as HTMLTextAreaElement | null;
    if (!textarea) return;

    const sync = () => setContent(textarea.value);
    sync();
    textarea.addEventListener("input", sync);
    return () => textarea.removeEventListener("input", sync);
  }, [targetTextareaId]);

  const preview = useMemo(() => content.trim(), [content]);

  return (
    <div className="preview-tabs-shell">
      <div className="preview-tabs-header" role="tablist" aria-label="Editor preview mode">
        <button
          type="button"
          className={`preview-tab ${activeTab === "write" ? "active" : ""}`}
          onClick={() => setActiveTab("write")}
        >
          Write
        </button>
        <button
          type="button"
          className={`preview-tab ${activeTab === "preview" ? "active" : ""}`}
          onClick={() => setActiveTab("preview")}
        >
          Preview
        </button>
      </div>

      {activeTab === "preview" && (
        <div className="preview-pane markdown-body">
          {preview ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          ) : (
            <p className="text-muted">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
