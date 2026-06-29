import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Window } from "happy-dom";
import React, { act } from "react";
import { MarkdownPreviewTabs } from "@/components/wiki/MarkdownPreviewTabs";
import { updateMarkdownTextarea } from "@/components/wiki/markdownTextareaUpdate";

type MediaQueryListener = (event: MediaQueryListEvent) => void;

interface MatchMediaController {
  setMatches: (matches: boolean) => void;
}

let matchMediaController: MatchMediaController;

function installDom(initialMatches = true) {
  const window = new Window();
  const listeners = new Set<MediaQueryListener>();
  const mediaQueryList = {
    matches: initialMatches,
    media: "(min-width: 980px)",
    onchange: null as ((event: MediaQueryListEvent) => void) | null,
    addEventListener: (_type: "change", listener: MediaQueryListener) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: MediaQueryListener) => listeners.delete(listener),
    addListener: (listener: MediaQueryListener) => listeners.add(listener),
    removeListener: (listener: MediaQueryListener) => listeners.delete(listener),
    dispatchEvent: () => true,
  };

  matchMediaController = {
    setMatches(matches: boolean) {
      mediaQueryList.matches = matches;
      const event = new window.Event("change") as unknown as MediaQueryListEvent;
      Object.defineProperties(event, {
        matches: { value: matches },
        media: { value: mediaQueryList.media },
      });
      mediaQueryList.onchange?.(event);
      for (const listener of listeners) listener(event);
    },
  };

  Object.assign(window, {
    matchMedia: () => mediaQueryList,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(window.performance.now());
      return 1;
    },
    cancelAnimationFrame: () => undefined,
  });

  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}

function renderEditor(props: Partial<React.ComponentProps<typeof MarkdownPreviewTabs>> = {}) {
  return render(
    React.createElement(MarkdownPreviewTabs, {
      targetTextareaId: "content",
      name: "content",
      ...props,
    }),
  );
}

beforeEach(() => installDom());

afterEach(() => {
  cleanup();
});

test("renders an ARIA radiogroup with one controlled editor target", () => {
  const view = renderEditor({ defaultValue: "## Hello", required: true, hint: "Supports Markdown." });

  const radios = view.getAllByRole("radio");
  assert.equal(radios.length, 3);
  for (const radio of radios) {
    assert.equal(radio.getAttribute("aria-controls"), "content-shell");
  }

  assert.ok(document.getElementById("content-shell"));
  assert.equal(view.getByRole("radio", { name: "Write" }).getAttribute("aria-checked"), "true");
  assert.equal(view.getByRole("radio", { name: "Split" }).getAttribute("aria-describedby"), "content-split-description");
  assert.equal(document.getElementById("content-split-description")?.textContent, "Shows the editor and rendered preview side by side.");
  assert.equal((view.getByRole("textbox") as HTMLTextAreaElement).required, true);
});

test("supports roving keyboard navigation without letting Space scroll the page", () => {
  const view = renderEditor({ defaultValue: "Ready to preview" });

  const group = view.getByRole("radiogroup", { name: "Editor mode" });
  fireEvent.keyDown(group, { key: "ArrowRight" });
  assert.equal(view.getByRole("radio", { name: "Preview" }).getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, view.getByRole("radio", { name: "Preview" }));

  fireEvent.keyDown(group, { key: "End" });
  assert.equal(view.getByRole("radio", { name: "Split" }).getAttribute("aria-checked"), "true");

  fireEvent.keyDown(group, { key: "Home" });
  assert.equal(view.getByRole("radio", { name: "Write" }).getAttribute("aria-checked"), "true");

  assert.equal(fireEvent.keyDown(group, { key: " " }), false);
});

test("keeps required empty content in write mode and reports textarea validity", () => {
  const view = renderEditor({ required: true });

  const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
  let reportValidityCalls = 0;
  textarea.reportValidity = () => {
    reportValidityCalls += 1;
    return false;
  };

  fireEvent.click(view.getByRole("radio", { name: "Preview" }));

  assert.equal(reportValidityCalls, 1);
  assert.equal(view.getByRole("radio", { name: "Write" }).getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, textarea);
});

test("keeps toolbar updates controlled and restores the requested selection", async () => {
  const view = renderEditor({ defaultValue: "alpha beta" });
  const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
  textarea.setSelectionRange(6, 10);

  await act(async () => {
    updateMarkdownTextarea("content", (value, start, end) => {
      const inserted = `**${value.slice(start, end)}**`;
      return {
        value: value.slice(0, start) + inserted + value.slice(end),
        cursor: start + inserted.length,
      };
    });
  });

  assert.equal(textarea.value, "alpha **beta**");
  assert.equal(textarea.selectionStart, 14);
  assert.equal(textarea.selectionEnd, 14);

  fireEvent.click(view.getByRole("radio", { name: "Preview" }));
  assert.ok(view.getByText("alpha").parentElement?.textContent?.includes("beta"));
});

test("falls back from split to preview using content state when split mode disappears", () => {
  const view = renderEditor({ defaultValue: "Preview me" });

  fireEvent.click(view.getByRole("radio", { name: "Split" }));
  assert.equal(view.getByRole("radio", { name: "Split" }).getAttribute("aria-checked"), "true");

  act(() => matchMediaController.setMatches(false));

  assert.equal(view.getByRole("radio", { name: "Preview" }).getAttribute("aria-checked"), "true");
});
