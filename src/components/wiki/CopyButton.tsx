"use client";

import { useState, type CSSProperties } from "react";

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  copiedStatusLabel?: string;
  failedStatusLabel?: string;
  className?: string;
}

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  failedLabel = "Copy failed",
  copiedStatusLabel = "Copied to clipboard.",
  failedStatusLabel = "Copy failed. The text was not copied.",
  className = "btn btn-secondary btn-sm",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const statusText = failed ? failedStatusLabel : copied ? copiedStatusLabel : "";

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        copyWithTextareaFallback(text);
      }
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      setFailed(true);
      console.error("Failed to copy text", error);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={handleCopy}>
        {failed ? failedLabel : copied ? copiedLabel : label}
      </button>
      <span aria-live="polite" aria-atomic="true" style={visuallyHiddenStyle}>
        {statusText}
      </span>
    </>
  );
}

const visuallyHiddenStyle = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: "1px",
} satisfies CSSProperties;

function copyWithTextareaFallback(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("document.execCommand('copy') returned false");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
