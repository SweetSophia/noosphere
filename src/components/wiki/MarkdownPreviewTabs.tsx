"use client";

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownToolbar } from "@/components/wiki/MarkdownToolbar";
import { WikiMarkdown } from "@/components/wiki/WikiMarkdown";
import {
  MARKDOWN_TEXTAREA_UPDATE_EVENT,
  type MarkdownTextareaUpdateDetail,
} from "@/components/wiki/markdownTextareaUpdate";

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
const STACKED_EDITOR_MODES = ["write", "preview"] as const satisfies readonly EditorMode[];

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
  const initialContent = defaultValue ?? "";
  const trimmedContentRef = useRef(initialContent.trim());
  const [activeMode, setActiveMode] = useState<EditorMode>("write");
  const [content, setContentState] = useState(initialContent);
  const [supportsSplitMode, setSupportsSplitMode] = useState(true);
  const shellId = `${targetTextareaId}-shell`;
  const writePaneId = `${targetTextareaId}-write`;
  const previewPaneId = `${targetTextareaId}-preview`;
  const splitDescriptionId = `${targetTextareaId}-split-description`;
  const trimmedContent = useMemo(() => content.trim(), [content]);

  function setContent(value: string) {
    trimmedContentRef.current = value.trim();
    setContentState(value);
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const syncControlledContent = (event: Event) => {
      const detail = (event as CustomEvent<MarkdownTextareaUpdateDetail>).detail;
      setContent(detail.value);
      requestAnimationFrame(() => {
        textarea.setSelectionRange(detail.selectionStart, detail.selectionEnd);
      });
    };

    textarea.addEventListener(MARKDOWN_TEXTAREA_UPDATE_EVENT, syncControlledContent);
    return () => textarea.removeEventListener(MARKDOWN_TEXTAREA_UPDATE_EVENT, syncControlledContent);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 980px)");
    const syncSplitSupport = () => {
      const matches = mediaQuery.matches;
      setSupportsSplitMode(matches);
      if (!matches) {
        setActiveMode((currentMode) => {
          if (currentMode !== "split") return currentMode;
          return trimmedContentRef.current ? "preview" : "write";
        });
      }
    };

    syncSplitSupport();
    mediaQuery.addEventListener("change", syncSplitSupport);
    return () => mediaQuery.removeEventListener("change", syncSplitSupport);
  }, []);

  const canHideEditor = !required || trimmedContent.length > 0;
  const availableModes: readonly EditorMode[] = supportsSplitMode ? EDITOR_MODES : STACKED_EDITOR_MODES;

  function selectMode(mode: EditorMode, options: { focusButton?: boolean } = {}) {
    const nextMode = mode === "split" && !supportsSplitMode ? "preview" : mode;

    if (nextMode === "preview" && !canHideEditor) {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.reportValidity();
      return;
    }

    setActiveMode(nextMode);
    if (options.focusButton) {
      requestAnimationFrame(() => modeButtonRefs.current[nextMode]?.focus());
    }
  }

  function selectModeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", " "].includes(event.key)) {
      return;
    }

    event.preventDefault();

    if (event.key === " ") {
      selectMode(activeMode, { focusButton: true });
      return;
    }

    const currentIndex = Math.max(availableModes.indexOf(activeMode), 0);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? availableModes.length - 1
          : (currentIndex + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + availableModes.length) %
            availableModes.length;
    const nextMode = availableModes[nextIndex] ?? activeMode;

    selectMode(nextMode, { focusButton: true });
  }

  return (
    <div id={shellId} className="markdown-editor-shell" data-mode={activeMode}>
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
            aria-controls={shellId}
            aria-describedby={mode === "split" ? splitDescriptionId : undefined}
            tabIndex={activeMode === mode ? 0 : -1}
            data-mode={mode}
            className={`preview-tab ${activeMode === mode ? "active" : ""}`}
            onClick={() => selectMode(mode)}
          >
            {getModeLabel(mode)}
          </button>
        ))}
        <span id={splitDescriptionId} className="screen-reader-only">
          Shows the editor and rendered preview side by side.
        </span>
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
            required={required}
            aria-describedby={hint && activeMode !== "preview" ? `${targetTextareaId}-hint` : undefined}
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
            <WikiMarkdown content={trimmedContent} />
          ) : activeMode === "split" ? (
            <p className="text-muted">Preview will appear here as you type.</p>
          ) : (
            <p className="text-muted">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
