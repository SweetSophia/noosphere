import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Window } from "happy-dom";
import React, { act } from "react";
import { ArticleWriteForm } from "@/components/wiki/ArticleWriteForm";

afterEach(cleanup);

test("wiki title feedback is visible and keeps the draft in the form", async () => {
  const window = new Window();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    Node: window.Node,
    FormData: window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let sent: FormData | undefined;
  let fallbackCalled = false;
  const view = render(React.createElement(ArticleWriteForm, {
    action: async () => { fallbackCalled = true; },
    feedbackAction: async (data: FormData) => {
      sent = data;
      return "Article title cannot consist only of injected context.";
    },
  }, [
    React.createElement("input", { key: "title", name: "title", defaultValue: "<recall>draft</recall>" }),
    React.createElement("textarea", { key: "content", name: "content", defaultValue: "Keep my draft" }),
    React.createElement("button", { key: "save", type: "submit" }, "Save"),
  ]));

  await act(async () => { fireEvent.submit(view.container.querySelector("form")!); });
  assert.equal(sent?.get("title"), "<recall>draft</recall>");
  assert.equal(sent?.get("content"), "Keep my draft");
  assert.equal(view.getByRole("alert").textContent, "Article title cannot consist only of injected context.");
  assert.equal((view.container.querySelector('input[name="title"]') as HTMLInputElement).value, "<recall>draft</recall>");
  assert.equal((view.container.querySelector("textarea") as HTMLTextAreaElement).value, "Keep my draft");
  assert.equal(fallbackCalled, false);
});
