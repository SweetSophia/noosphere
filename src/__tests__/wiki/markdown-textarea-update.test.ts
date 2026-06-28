import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  MARKDOWN_TEXTAREA_UPDATE_EVENT,
  type MarkdownTextareaUpdateDetail,
  updateMarkdownTextarea,
} from "@/components/wiki/markdownTextareaUpdate";

class FakeTextarea extends EventTarget {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  focused = false;

  constructor(value: string) {
    super();
    this.value = value;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
  }

  focus() {
    this.focused = true;
  }

  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class TestCustomEvent<T> extends Event {
  detail: T;

  constructor(type: string, eventInitDict?: CustomEventInit<T>) {
    super(type, eventInitDict);
    this.detail = eventInitDict?.detail as T;
  }
}

const originalDocument = globalThis.document;
const originalCustomEvent = globalThis.CustomEvent;

beforeEach(() => {
  if (!globalThis.CustomEvent) {
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: TestCustomEvent,
    });
  }
});

afterEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: originalCustomEvent,
  });
});

test("updates the textarea and emits a controlled-editor sync event", () => {
  const textarea = new FakeTextarea("alpha beta");
  textarea.selectionStart = 6;
  textarea.selectionEnd = 10;
  let updateDetail: MarkdownTextareaUpdateDetail | undefined;
  let inputDispatched = false;

  textarea.addEventListener(MARKDOWN_TEXTAREA_UPDATE_EVENT, (event) => {
    updateDetail = (event as CustomEvent<MarkdownTextareaUpdateDetail>).detail;
  });
  textarea.addEventListener("input", () => {
    inputDispatched = true;
  });

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (id: string) => (id === "content" ? textarea : null),
    },
  });

  updateMarkdownTextarea("content", (value, start, end) => {
    const inserted = `**${value.slice(start, end)}**`;
    return {
      value: value.slice(0, start) + inserted + value.slice(end),
      cursor: start + inserted.length,
    };
  });

  assert.equal(textarea.value, "alpha **beta**");
  assert.equal(textarea.selectionStart, 14);
  assert.equal(textarea.selectionEnd, 14);
  assert.equal(textarea.focused, true);
  assert.equal(inputDispatched, true);
  assert.deepEqual(updateDetail, {
    value: "alpha **beta**",
    selectionStart: 14,
    selectionEnd: 14,
  });
});

test("does nothing when the target textarea is absent", () => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: () => null,
    },
  });

  assert.doesNotThrow(() =>
    updateMarkdownTextarea("missing", () => ({
      value: "unused",
      cursor: 0,
    })),
  );
});
