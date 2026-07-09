import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export const ARTICLE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
  },
};

export const ARTICLE_REMARK_PLUGINS: PluggableList = [remarkGfm];
export const ARTICLE_REHYPE_PLUGINS: PluggableList = [[rehypeSanitize, ARTICLE_SANITIZE_SCHEMA]];

const LANGUAGE_CLASS_PATTERN = /\blanguage-([\w-]+)\b/;

const ARTICLE_MARKDOWN_COMPONENTS: Components = {
  code({ className, children, ...props }) {
    const codeProps = { ...props };
    delete (codeProps as { node?: unknown }).node;

    const match = LANGUAGE_CLASS_PATTERN.exec(className || "");
    if (className && match) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
        >
          {String(children).replace(/\n$/, "")}
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
