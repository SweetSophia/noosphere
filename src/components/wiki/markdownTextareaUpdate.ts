"use client";

export const MARKDOWN_TEXTAREA_UPDATE_EVENT = "noosphere:markdown-textarea-update";

export interface MarkdownTextareaUpdateDetail {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface MarkdownTextareaUpdate {
  value: string;
  cursor: number;
  selectionEnd?: number;
}

export function updateMarkdownTextarea(
  targetTextareaId: string,
  transform: (value: string, start: number, end: number) => MarkdownTextareaUpdate,
) {
  const textarea = document.getElementById(targetTextareaId) as HTMLTextAreaElement | null;
  if (!textarea) return;

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const next = transform(textarea.value, start, end);
  const selectionEnd = next.selectionEnd ?? next.cursor;

  textarea.value = next.value;
  textarea.focus();
  textarea.setSelectionRange(next.cursor, selectionEnd);
  textarea.dispatchEvent(
    new CustomEvent<MarkdownTextareaUpdateDetail>(MARKDOWN_TEXTAREA_UPDATE_EVENT, {
      // Keep this observable above the textarea for browser tooling and future editor instrumentation.
      bubbles: true,
      detail: {
        value: next.value,
        selectionStart: next.cursor,
        selectionEnd,
      },
    }),
  );
}
