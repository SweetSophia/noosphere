"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// Extend default schema to preserve className on code/pre for syntax highlighting
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
  },
};

interface MarkdownPreviewTabsProps {
  targetTextareaId: string;
  defaultValue?: string;
}

export function MarkdownPreviewTabs({ targetTextareaId, defaultValue = "" }: MarkdownPreviewTabsProps) {
  const [activeTab, setActiveTab] = useState<"write" | "preview">("write");
  const [content, setContent] = useState(defaultValue);

  const sync = useCallback(() => {
    const textarea = document.getElementById(targetTextareaId);
    if (textarea instanceof HTMLTextAreaElement) {
      setContent(textarea.value);
    }
  }, [targetTextareaId]);

  // Sync content when defaultValue prop changes (e.g., switching articles)
  useEffect(() => {
    setContent(defaultValue);
  }, [defaultValue]);

  useEffect(() => {
    const textarea = document.getElementById(targetTextareaId);
    if (!(textarea instanceof HTMLTextAreaElement)) return;

    // Initial sync — textarea found, content already set from defaultValue or useEffect
    sync();

    textarea.addEventListener("input", sync, { passive: true });
    return () => {
      textarea.removeEventListener("input", sync);
    };
  }, [targetTextareaId, sync]);

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
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}>{preview}</ReactMarkdown>
          ) : (
            <p className="text-muted">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
