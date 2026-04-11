"use client";

const ACTIONS = [
  { label: "H2", mode: "line-prefix", value: "## " },
  { label: "Bold", mode: "wrap", before: "**", after: "**", placeholder: "bold text" },
  { label: "Link", mode: "wrap", before: "[", after: "](https://example.com)", placeholder: "link text" },
  { label: "Code", mode: "wrap", before: "`", after: "`", placeholder: "code" },
  { label: "Quote", mode: "line-prefix", value: "> " },
  { label: "List", mode: "line-prefix", value: "- " },
  { label: "Checklist", mode: "line-prefix", value: "- [ ] " },
  { label: "Code Block", mode: "block", value: "```txt\ncode here\n```" },
  { label: "Table", mode: "block", value: "| Column | Value |\n| --- | --- |\n| Example | Text |" },
  { label: "Image", mode: "block", value: "![alt text](/uploads/images/example.png)" },
] as const;

interface MarkdownToolbarProps {
  targetTextareaId: string;
}

export function MarkdownToolbar({ targetTextareaId }: MarkdownToolbarProps) {
  function updateTextarea(transform: (value: string, start: number, end: number) => { value: string; cursor: number }) {
    const textarea = document.getElementById(targetTextareaId) as HTMLTextAreaElement | null;
    if (!textarea) return;

    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const next = transform(textarea.value, start, end);

    textarea.value = next.value;
    textarea.focus();
    textarea.setSelectionRange(next.cursor, next.cursor);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function applyWrap(before: string, after: string, placeholder: string) {
    updateTextarea((value, start, end) => {
      const selected = value.slice(start, end) || placeholder;
      const inserted = `${before}${selected}${after}`;
      return {
        value: value.slice(0, start) + inserted + value.slice(end),
        cursor: start + inserted.length,
      };
    });
  }

  function applyLinePrefix(prefix: string) {
    updateTextarea((value, start, end) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const selected = value.slice(lineStart, end || start);
      const segment = selected || "item";
      const inserted = segment
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
      return {
        value: value.slice(0, lineStart) + inserted + value.slice(end || start),
        cursor: lineStart + inserted.length,
      };
    });
  }

  function applyBlock(block: string) {
    updateTextarea((value, start, end) => {
      const spacerBefore = start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
      const spacerAfter = end < value.length && value[end] !== "\n" ? "\n\n" : "\n";
      const inserted = `${spacerBefore}${block}${spacerAfter}`;
      return {
        value: value.slice(0, start) + inserted + value.slice(end),
        cursor: start + inserted.length,
      };
    });
  }

  return (
    <div className="markdown-toolbar" role="toolbar" aria-label="Markdown formatting toolbar">
      {ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            if (action.mode === "wrap") {
              applyWrap(action.before, action.after, action.placeholder);
              return;
            }
            if (action.mode === "line-prefix") {
              applyLinePrefix(action.value);
              return;
            }
            applyBlock(action.value);
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
