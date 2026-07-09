import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

import { MermaidDiagram } from "./MermaidDiagram";

const KATEX_TAG_NAMES = [
  "annotation",
  "math",
  "menclose",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "semantics",
];

export const ARTICLE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...KATEX_TAG_NAMES],
  attributes: {
    ...defaultSchema.attributes,
    annotation: [...(defaultSchema.attributes?.annotation ?? []), "encoding"],
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    math: [...(defaultSchema.attributes?.math ?? []), "xmlns"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      "aria-hidden",
      "ariaHidden",
      "className",
      "style",
    ],
  },
};

export const ARTICLE_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];
export const ARTICLE_REHYPE_PLUGINS: PluggableList = [
  rehypeKatex,
  [rehypeSanitize, ARTICLE_SANITIZE_SCHEMA],
];

const LANGUAGE_CLASS_PATTERN = /\blanguage-([\w-]+)\b/;

const ARTICLE_MARKDOWN_COMPONENTS: Components = {
  // react-markdown wraps fenced code blocks in <pre><code>…</code></pre>.
  // When the inner code element is a mermaid diagram we return a <figure>,
  // so we must unwrap the parent <pre> to avoid invalid nested <pre> HTML.
  // At this point the `code` child is still an unrendered React element, so we
  // inspect its props.className for the `language-mermaid` marker.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const childProps =
      child != null && typeof child === "object" && "props" in child
        ? (child as { props?: { className?: string } }).props
        : undefined;
    if (childProps && /\blanguage-mermaid\b/.test(childProps.className || "")) {
      return <>{children}</>;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children, ...props }) {
    const codeProps = { ...props };
    delete (codeProps as { node?: unknown }).node;

    const match = LANGUAGE_CLASS_PATTERN.exec(className || "");
    const language = match?.[1];
    const code = String(children).replace(/\n$/, "");

    if (language === "mermaid") {
      return <MermaidDiagram code={code} />;
    }

    if (className && language) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
        >
          {code}
        </SyntaxHighlighter>
      );
    }

    return (
      <code className={className} {...codeProps}>
        {children}
      </code>
    );
  },
};

interface WikiMarkdownProps {
  content: string;
}

export function WikiMarkdown({ content }: WikiMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={ARTICLE_REMARK_PLUGINS}
      rehypePlugins={ARTICLE_REHYPE_PLUGINS}
      components={ARTICLE_MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
}
