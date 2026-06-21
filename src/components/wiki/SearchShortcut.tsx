"use client";

import { useEffect } from "react";

interface SearchShortcutProps {
  targetId: string;
}

function isEditableElement(element: Element | null) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

export function SearchShortcut({ targetId }: SearchShortcutProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key.toLowerCase() !== "k") return;

      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      const hasExtraModifiers = event.altKey || event.shiftKey;
      if (!hasPrimaryModifier || hasExtraModifiers) return;

      const target = document.getElementById(targetId);
      if (!(target instanceof HTMLElement)) return;

      if (document.activeElement !== target && isEditableElement(document.activeElement)) {
        return;
      }

      event.preventDefault();
      target.focus();

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [targetId]);

  return null;
}
