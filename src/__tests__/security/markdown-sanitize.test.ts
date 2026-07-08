import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * B4: Verify that server-side markdown rendering sanitizes dangerous HTML.
 *
 * The wiki article SSR path (src/app/wiki/[topicSlug]/[articleSlug]/page.tsx)
 * uses ReactMarkdown + remarkGfm + rehype-sanitize with an extended schema
 * that preserves className on code/pre for syntax highlighting.
 *
 * This test asserts that <script>, <iframe>, inline event handlers, and
 * javascript: URLs in markdown content are rendered as inert text,
 * not executable HTML.
 */

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
  },
};

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [[rehypeSanitize, sanitizeSchema]],
      },
      content,
    ),
  );
}

test("B4: <script> tags are rendered as inert text, not executable HTML", () => {
  const malicious = 'Some text\n\n<script>alert("xss")</script>\n\nMore text';
  const html = renderMarkdown(malicious);

  // rehype-sanitize strips the entire <script> element (tag + content)
  assert.doesNotMatch(html, /<script\b/);
  // Surrounding text is preserved
  assert.ok(html.includes("Some text"), "surrounding text should be preserved");
  assert.ok(html.includes("More text"), "surrounding text should be preserved");
});

test("B4: <iframe> tags are rendered as inert text", () => {
  const malicious = '<iframe src="https://evil.example.com"></iframe>\n\nText';
  const html = renderMarkdown(malicious);

  assert.doesNotMatch(html, /<iframe\b/);
});

test("B4: inline event handlers (onclick) are stripped from links", () => {
  const malicious = '<a href="https://ok.example.com" onclick="alert(1)">link</a>';
  const html = renderMarkdown(malicious);

  assert.ok(!html.includes("onclick"), "onclick must be stripped");
});

test("B4: javascript: URLs are stripped from markdown links", () => {
  const malicious = "[click me](javascript:void(0))";
  const html = renderMarkdown(malicious);

  assert.ok(!html.includes("javascript:"), "javascript: protocol must be stripped");
});

test("B4: legitimate markdown formatting is preserved", () => {
  const legit = "# Heading\n\n**bold** and *italic* and `code`\n\n- item";
  const html = renderMarkdown(legit);

  assert.ok(html.includes("<h1>"), "h1 should be preserved");
  assert.ok(html.includes("<strong>"), "bold should be preserved");
  assert.ok(html.includes("<em>"), "italic should be preserved");
  assert.ok(html.includes("<code>"), "inline code should be preserved");
});

test("B4: code block className is preserved for syntax highlighting", () => {
  const codeBlock = "```js\nconst x = 1;\n```";
  const html = renderMarkdown(codeBlock);

  assert.match(html, /language-js/, "language-js className should be preserved");
});
