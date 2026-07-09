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

test("B4: shared markdown config preserves syntax-highlight and math classes", () => {
  const rehypeSanitizeEntry = ARTICLE_REHYPE_PLUGINS.find(
    (plugin) => Array.isArray(plugin) && plugin[1] === ARTICLE_SANITIZE_SCHEMA,
  ) as unknown[] | undefined;

  assert.ok(ARTICLE_REMARK_PLUGINS.length > 0, "remark plugins should be configured");
  assert.ok(rehypeSanitizeEntry, "rehype-sanitize should be configured");
  assert.strictEqual(
    rehypeSanitizeEntry[1],
    ARTICLE_SANITIZE_SCHEMA,
    "rehype-sanitize should use the exported article sanitize schema",
  );
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.code?.includes("className"));
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.pre?.includes("className"));
  assert.ok(ARTICLE_SANITIZE_SCHEMA.tagNames?.includes("math"));
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.span?.includes("ariaHidden"));
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.span?.includes("className"));
  assert.ok(ARTICLE_SANITIZE_SCHEMA.attributes?.span?.includes("style"));
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

test("#273: LaTeX math renders through KaTeX markup", () => {
  const math = "Inline $a^2 + b^2 = c^2$.\n\n$$\\frac{1}{2}$$";
  const html = renderMarkdown(math);

  assert.match(html, /\bkatex\b/, "KaTeX wrapper class should be preserved");
  assert.match(html, /aria-hidden="true"/, "visual KaTeX HTML should remain hidden from assistive tech");
  assert.match(html, /<math\b/, "MathML output should be preserved");
  assert.match(html, /<annotation\b[^>]*encoding="application\/x-tex"/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("#273: math links cannot render javascript hrefs", () => {
  const malicious = "$\\href{javascript:alert(1)}{click}$";
  const html = renderMarkdown(malicious);

  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<script\b/i);
});

test("#273: KaTeX HTML extensions do not create user-controlled attributes", () => {
  const originalWarn = console.warn;
  let html = "";

  console.warn = () => {};
  try {
    html = renderMarkdown(
      "$\\htmlStyle{background:url(javascript:alert(1))}{x}$\n\n$\\htmlClass{evil}{x}$",
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.doesNotMatch(html, /style="[^"]*javascript:/i);
  assert.doesNotMatch(html, /class="evil"/i);
  assert.doesNotMatch(html, /href=/i);
});

test("#273: mermaid code blocks render through the diagram wrapper", () => {
  const diagram = "```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```";
  const html = renderMarkdown(diagram);

  assert.match(html, /class="mermaid-container"/);
  assert.match(html, /class="mermaid-fallback"/);
  assert.ok(html.includes("graph TD"), "diagram source should be available before hydration");
  assert.doesNotMatch(html, /\blanguage-mermaid\b/);
  // M-1 fix: react-markdown must not wrap the mermaid <figure> in a <pre>
  assert.doesNotMatch(
    html,
    /<pre>[^<]*<figure[^>]*mermaid-container/,
    "mermaid figure must not be nested inside a <pre>",
  );
});

test("#273: mermaid fallback escapes dangerous diagram source", () => {
  const diagram = "```mermaid\ngraph TD\n  A[<script>alert(1)</script>] --> B\n```";
  const html = renderMarkdown(diagram);

  assert.match(html, /class="mermaid-container"/);
  assert.doesNotMatch(html, /<script\b/i);
});
