import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ARTICLE_REHYPE_PLUGINS,
  ARTICLE_REMARK_PLUGINS,
  ARTICLE_SANITIZE_SCHEMA,
  WikiMarkdown,
} from "@/components/wiki/WikiMarkdown";

/**
 * B4: Verify that server-side markdown rendering sanitizes dangerous HTML.
 *
 * These tests render the shared WikiMarkdown component used by the SSR article
 * page and the editor preview, so they fail if production markdown wiring
 * drifts away from rehype-sanitize or the shared syntax-highlighting mapping.
 */

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(React.createElement(WikiMarkdown, { content }));
}

test("B4: shared markdown config preserves syntax-highlight classes", () => {
  const [rehypeSanitizeEntry] = ARTICLE_REHYPE_PLUGINS as [unknown[]];

  assert.ok(ARTICLE_REMARK_PLUGINS.length > 0, "remark plugins should be configured");
  assert.strictEqual(
    rehypeSanitizeEntry[1],
    ARTICLE_SANITIZE_SCHEMA,
    "rehype-sanitize should use the exported article sanitize schema",
  );
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.code?.includes("className"));
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.pre?.includes("className"));
});

test("B4: <script> tags are rendered as inert text, not executable HTML", () => {
  const malicious = 'Some text\n\n<script>alert("xss")</script>\n\nMore text';
  const html = renderMarkdown(malicious);

  // rehype-sanitize strips the entire <script> element (tag + content)
  assert.doesNotMatch(html, /<script\b/);
  assert.doesNotMatch(html, /alert\("xss"\)/);
  // Surrounding text is preserved
  assert.ok(html.includes("Some text"), "surrounding text should be preserved");
  assert.ok(html.includes("More text"), "surrounding text should be preserved");
});

test("B4: <iframe> tags are rendered as inert text", () => {
  const malicious = '<iframe src="https://evil.example.com"></iframe>\n\nText';
  const html = renderMarkdown(malicious);

  assert.doesNotMatch(html, /<iframe\b/);
});

test("B4: raw HTML with inline event handlers is stripped (no tag or handler appears in output)", () => {
  // ReactMarkdown + rehype-sanitize (without rehype-raw) treats raw HTML in the source
  // as text that gets sanitized. An <a> with onclick never becomes a rendered element
  // with the attribute because sanitize removes unknown/dangerous constructs.
  // We assert both the dangerous attribute and the tag are absent.
  const malicious = '<a href="https://ok.example.com" onclick="alert(1)">link</a>';
  const html = renderMarkdown(malicious);

  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /<a\b/);
});

test("B4: safe markdown links preserve href attributes", () => {
  const safeLink = "[safe link](https://ok.example.com)";
  const html = renderMarkdown(safeLink);

  assert.match(html, /href="https:\/\/ok\.example\.com"/);
  assert.ok(html.includes("safe link"), "safe link text should be preserved");
});

test("B4: javascript: URLs are stripped from markdown links", () => {
  const malicious = "[click me](JaVaScRiPt:void(0))";
  const html = renderMarkdown(malicious);

  assert.doesNotMatch(html, /javascript:/i, "javascript: protocol must be stripped");
});

test("B4: legitimate markdown formatting is preserved", () => {
  const legit = "# Heading\n\n**bold** and *italic* and `code`\n\n- item";
  const html = renderMarkdown(legit);

  assert.ok(html.includes("<h1>"), "h1 should be preserved");
  assert.ok(html.includes("<strong>"), "bold should be preserved");
  assert.ok(html.includes("<em>"), "italic should be preserved");
  assert.match(html, /<code\b[^>]*>code<\/code>/, "inline code should be preserved");
  assert.doesNotMatch(html, /node="\[object Object\]"/, "ReactMarkdown internals should not leak to HTML");
  assert.ok(html.includes("<ul>"), "unordered lists should be preserved");
  assert.ok(html.includes("<li>"), "list items should be preserved");
});

test("B4: code block className is preserved for syntax highlighting", () => {
  const codeBlock = "```js\nconst x = 1;\n```";
  const jsonBlock = "```json\n{\"x\":1}\n```";
  const html = renderMarkdown(codeBlock);
  const jsonHtml = renderMarkdown(jsonBlock);

  assert.match(html, /\blanguage-js\b/, "language-js className should be preserved");
  assert.match(jsonHtml, /\blanguage-json\b/, "language-json className should be preserved");
  assert.doesNotMatch(jsonHtml, /\blanguage-js\b/, "language-json should not satisfy language-js checks");
});
