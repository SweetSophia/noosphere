"use client";

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { MarkdownToolbar } from "@/components/wiki/MarkdownToolbar";

// Extend default schema to preserve className on code/pre for syntax highlighting
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
  },
};

const REMARK_PLUGINS: PluggableList = [remarkGfm];
const REHYPE_PLUGINS: PluggableList = [[rehypeSanitize, sanitizeSchema]];

interface MarkdownPreviewTabsProps {
  targetTextareaId: string;
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  required?: boolean;
  hint?: string;
}

type EditorMode = "write" | "preview" | "split";

const EDITOR_MODES = ["write", "preview", "split"] as const satisfies readonly EditorMode[];

function getModeLabel(mode: EditorMode) {
  return mode === "write" ? "Write" : mode === "preview" ? "Preview" : "Split";
}

export function MarkdownPreviewTabs({
  targetTextareaId,
  name,
  defaultValue,
  placeholder = "Write your article in Markdown...",
  required = false,
  hint,
}: MarkdownPreviewTabsProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modeButtonRefs = useRef<Record<EditorMode, HTMLButtonElement | null>>({
    write: null,
    preview: null,
    split: null,
  });
  const [activeMode, setActiveMode] = useState<EditorMode>("write");
  const [content, setContent] = useState(defaultValue ?? "");
  const writePaneId = `${targetTextareaId}-write`;
  const previewPaneId = `${targetTextareaId}-preview`;

  // Sync content when defaultValue prop changes (e.g., switching articles)
  useEffect(() => {
    let isCurrent = true;

    queueMicrotask(() => {
      if (isCurrent) {
        setContent(defaultValue ?? "");
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [defaultValue]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const sync = () => setContent(textarea.value);

    // Toolbar and image insertion update the DOM textarea directly, then emit input.
    sync();
    textarea.addEventListener("input", sync, { passive: true });
    return () => textarea.removeEventListener("input", sync);
  }, []);

  const trimmedContent = useMemo(() => content.trim(), [content]);
  const canHideEditor = !required || trimmedContent.length > 0;

  function selectMode(mode: EditorMode, options: { focusButton?: boolean } = {}) {
    if (mode === "preview" && !canHideEditor) {
      if (options.focusButton) {
        requestAnimationFrame(() => modeButtonRefs.current[activeMode]?.focus());
      } else {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.reportValidity();
      }
      return;
    }

    setActiveMode(mode);
    if (options.focusButton) {
      requestAnimationFrame(() => modeButtonRefs.current[mode]?.focus());
    }
  }

  function selectModeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();

    const currentIndex = EDITOR_MODES.indexOf(activeMode);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? EDITOR_MODES.length - 1
          : (currentIndex + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + EDITOR_MODES.length) %
            EDITOR_MODES.length;
    const nextMode = EDITOR_MODES[nextIndex] ?? activeMode;

    selectMode(nextMode, { focusButton: true });
  }

  function getModeControls(mode: EditorMode) {
    if (mode === "split") return `${writePaneId} ${previewPaneId}`;
    return mode === "preview" ? previewPaneId : writePaneId;
  }

  return (
    <div className="markdown-editor-shell" data-mode={activeMode}>
      <div
        className="preview-tabs-header"
        role="radiogroup"
        aria-label="Editor mode"
        aria-orientation="horizontal"
        onKeyDown={selectModeFromKeyboard}
      >
        {EDITOR_MODES.map((mode) => (
          <button
            key={mode}
            ref={(button) => {
              modeButtonRefs.current[mode] = button;
            }}
            type="button"
            role="radio"
            aria-checked={activeMode === mode}
            aria-controls={getModeControls(mode)}
            tabIndex={activeMode === mode ? 0 : -1}
            className={`preview-tab ${activeMode === mode ? "active" : ""}`}
            onClick={() => selectMode(mode)}
          >
            {getModeLabel(mode)}
          </button>
        ))}
      </div>

      <div className="markdown-editor-grid">
        <div id={writePaneId} className="markdown-editor-write">
          <MarkdownToolbar targetTextareaId={targetTextareaId} />
          <textarea
            ref={textareaRef}
            id={targetTextareaId}
            name={name}
            className="form-textarea markdown-editor-textarea"
            value={content}
            placeholder={placeholder}
            required={required && activeMode !== "preview"}
            aria-describedby={hint ? `${targetTextareaId}-hint` : undefined}
            onChange={(event) => setContent(event.currentTarget.value)}
          />
          {hint ? (
            <p id={`${targetTextareaId}-hint`} className="form-hint">
              {hint}
            </p>
          ) : null}
        </div>

        <div id={previewPaneId} className="markdown-editor-preview preview-pane markdown-body">
          {activeMode === "write" ? null : trimmedContent ? (
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{trimmedContent}</ReactMarkdown>
          ) : (
            <p className="text-muted">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
