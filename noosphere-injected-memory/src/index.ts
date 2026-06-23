const INJECTED_MEMORY_BLOCKS = [
  // Tag names are embedded directly in RegExp sources; avoid metacharacters.
  "recall",
  "hindsight_memories",
  "noosphere_auto_recall",
] as const;

export type InjectedMemoryBlock = (typeof INJECTED_MEMORY_BLOCKS)[number];

export type InjectedMemoryStripMode =
  | "openclaw-article-create"
  | "server-save";

type InjectedMemoryStripModeConfig = {
  open: "tag-boundary" | "word-boundary";
  closeAllowsWhitespace: boolean;
  unclosed: "throw" | "truncate-tail";
};

type InjectedMemoryPatterns = {
  open: RegExp;
  openGlobal: RegExp;
  close: RegExp;
};

const STRIP_MODE_CONFIGS = {
  "openclaw-article-create": {
    open: "tag-boundary",
    closeAllowsWhitespace: true,
    unclosed: "throw",
  },
  "server-save": {
    open: "word-boundary",
    closeAllowsWhitespace: false,
    unclosed: "truncate-tail",
  },
} as const satisfies Record<InjectedMemoryStripMode, InjectedMemoryStripModeConfig>;

export const OPENCLAW_ARTICLE_CREATE_STRIP_MODE = "openclaw-article-create" as const;
export const SERVER_MEMORY_SAVE_STRIP_MODE = "server-save" as const;

const INJECTED_MEMORY_PATTERN_SETS = fromEntries(
  Object.entries(STRIP_MODE_CONFIGS).map(([mode, config]) => [
    mode,
    buildPatternSet(config),
  ]),
);

export function stripInjectedMemoryBlocks(
  content: string,
  mode: InjectedMemoryStripMode,
): {
  content: string;
  strippedBlocks: string[];
} {
  let strippedContent = content;
  const strippedBlocks: string[] = [];

  for (const tag of INJECTED_MEMORY_BLOCKS) {
    let nextContent = stripOneInjectedTag(strippedContent, tag, mode);
    while (nextContent.changed) {
      strippedBlocks.push(tag);
      strippedContent = nextContent.content;
      nextContent = stripOneInjectedTag(strippedContent, tag, mode);
    }
  }

  return { content: strippedContent, strippedBlocks };
}

function buildPatternSet(
  config: InjectedMemoryStripModeConfig,
): Record<InjectedMemoryBlock, InjectedMemoryPatterns> {
  return fromEntries(
    INJECTED_MEMORY_BLOCKS.map((tag) => {
      const openBoundary =
        config.open === "tag-boundary" ? "(?=[\\s>/])" : "\\b";
      const closeSuffix = config.closeAllowsWhitespace ? "\\s*" : "";

      return [
        tag,
        {
          open: new RegExp(`<${tag}${openBoundary}[^>]*>`, "i"),
          openGlobal: new RegExp(`<${tag}${openBoundary}[^>]*>`, "gi"),
          close: new RegExp(`</${tag}${closeSuffix}>`, "gi"),
        },
      ];
    }),
  );
}

function stripOneInjectedTag(
  content: string,
  tag: InjectedMemoryBlock,
  mode: InjectedMemoryStripMode,
): { content: string; changed: boolean } {
  const config = STRIP_MODE_CONFIGS[mode];
  const patterns = INJECTED_MEMORY_PATTERN_SETS[mode][tag];
  patterns.openGlobal.lastIndex = 0;
  patterns.close.lastIndex = 0;

  const openMatch = patterns.open.exec(content);
  if (!openMatch) return { content, changed: false };

  const { close: closePattern, openGlobal: openSearchPattern } = patterns;
  let depth = 1;
  let cursor = openMatch.index + openMatch[0].length;

  while (true) {
    openSearchPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const nestedOpen = openSearchPattern.exec(content);
    const closeMatch = closePattern.exec(content);

    if (!closeMatch) {
      if (config.unclosed === "throw") {
        throw new Error(`Unclosed memory block tag: <${tag}>`);
      }

      return {
        content: `${content.slice(0, openMatch.index)}\n`,
        changed: true,
      };
    }

    if (nestedOpen && nestedOpen.index < closeMatch.index) {
      depth += 1;
      cursor = nestedOpen.index + nestedOpen[0].length;
      continue;
    }

    depth -= 1;
    cursor = closeMatch.index + closeMatch[0].length;
    if (depth === 0) {
      return {
        content: `${content.slice(0, openMatch.index)}\n${content.slice(cursor)}`,
        changed: true,
      };
    }
  }
}

function fromEntries<K extends string, V>(
  entries: readonly (readonly [K, V])[],
): Record<K, V> {
  return Object.fromEntries(entries) as Record<K, V>;
}
