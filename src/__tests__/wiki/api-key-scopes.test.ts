import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ScopeBadges, ScopePicker } from "@/components/wiki/ApiKeyScopes";

const scopes = [{ tag: "team-a", description: "Team A", isSystem: false }];
function formFor(selected: string[], available = scopes) {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(
    React.createElement("form", null, React.createElement(ScopePicker, { scopes: available, selected })),
  );
  return { window, form: window.document.querySelector("form")! };
}
for (const selected of [[], ["team-a"], ["*"], ["team-a", "*"]]) {
  test(`scope picker round-trips explicit selection ${JSON.stringify(selected)}`, () => {
    const { window, form } = formFor(selected);
    const submitted = new window.FormData(form).getAll("scopes").map(String).sort();
    assert.deepEqual(submitted, [...selected].sort());
    const wildcard = form.querySelector('input[value="*"]');
    assert.ok(wildcard, "full scope must be an explicit checkbox, not a hidden grant");
    assert.equal(wildcard.getAttribute("type"), "checkbox");
  });
}
test("full scope is selectable even when no concrete scopes exist, and is not a default", () => {
  const { window, form } = formFor([], []);
  const wildcard = form.querySelector('input[value="*"]') as HTMLInputElement | null;
  assert.ok(wildcard);
  assert.equal(wildcard.checked, false);
  wildcard.checked = true;
  assert.deepEqual(new window.FormData(form).getAll("scopes"), ["*"]);
  assert.match(form.textContent ?? "", /all restricted/i);
});
test("clearing wildcard is explicit and preserves independently selected private scope", () => {
  const { window, form } = formFor(["*", "team-a"]);
  const wildcard = form.querySelector('input[value="*"]') as HTMLInputElement | null;
  assert.ok(wildcard);
  wildcard.checked = false;
  assert.deepEqual(new window.FormData(form).getAll("scopes"), ["team-a"]);
});
test("badges distinguish public-only, scoped, and full-content access", () => {
  const html = (value: string[]) => renderToStaticMarkup(React.createElement(ScopeBadges, { scopes: value }));
  assert.match(html([]), /Public articles only/);
  assert.doesNotMatch(html([]), /Unrestricted|Full access/);
  assert.match(html(["*"]), /Full access/);
  assert.match(html(["team-a"]), /team-a/);
  assert.doesNotMatch(html(["team-a"]), /Full access/);
  assert.match(html(["*", "team-a"]), /team-a/, "private scope remains visible for principal-bound keys");
});
