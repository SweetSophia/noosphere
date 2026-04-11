"use client";

import { useState } from "react";

interface ImageUploadPanelProps {
  targetTextareaId: string;
}

interface UploadSuccess {
  url: string;
  markdown: string;
  filename: string;
}

export function ImageUploadPanel({ targetTextareaId }: ImageUploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<UploadSuccess | null>(null);

  async function handleUpload() {
    if (!file) {
      setError("Choose an image first.");
      return;
    }

    setUploading(true);
    setError("");
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("alt", alt);

      const response = await fetch("/api/uploads/image", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });

      const data = (await response.json()) as UploadSuccess & { error?: string };

      if (!response.ok) {
        throw new Error(data.error || "Upload failed.");
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function insertMarkdown() {
    if (!result) return;

    const textarea = document.getElementById(targetTextareaId) as HTMLTextAreaElement | null;
    if (!textarea) return;

    const snippet = `\n${result.markdown}\n`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const nextValue = textarea.value.slice(0, start) + snippet + textarea.value.slice(end);
    textarea.value = nextValue;
    textarea.focus();
    textarea.setSelectionRange(start + snippet.length, start + snippet.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  return (
    <div className="upload-panel">
      <div className="upload-panel-header">
        <h3>Image Upload</h3>
        <p>Upload an image and insert ready-to-use Markdown.</p>
      </div>

      <div className="upload-grid">
        <div className="form-group">
          <label className="form-label" htmlFor={`${targetTextareaId}-image`}>
            Image file
          </label>
          <input
            id={`${targetTextareaId}-image`}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="form-input"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor={`${targetTextareaId}-alt`}>
            Alt text
          </label>
          <input
            id={`${targetTextareaId}-alt`}
            type="text"
            className="form-input"
            placeholder="Architecture diagram"
            value={alt}
            onChange={(event) => setAlt(event.target.value)}
          />
        </div>
      </div>

      <div className="upload-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleUpload} disabled={uploading}>
          {uploading ? "Uploading..." : "Upload image"}
        </button>
        {result && (
          <button type="button" className="btn btn-primary btn-sm" onClick={insertMarkdown}>
            Insert Markdown
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <div className="upload-result">
          <div><strong>URL:</strong> <code>{result.url}</code></div>
          <div><strong>Markdown:</strong> <code>{result.markdown}</code></div>
        </div>
      )}
    </div>
  );
}
