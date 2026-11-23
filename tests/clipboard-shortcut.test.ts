import { test } from "node:test";
import assert from "node:assert/strict";
import { clipboardShortcut } from "../lib/clipboard-shortcut.ts";

const base = { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false };

test("node clipboard shortcuts accept Command and Control with either letter case", () => {
  for (const [key, command] of [["c", "copy"], ["x", "cut"], ["v", "paste"]] as const) {
    for (const modifier of ["metaKey", "ctrlKey"] as const) {
      for (const letter of [key, key.toUpperCase()]) {
        assert.equal(clipboardShortcut({ ...base, key: letter, code: `Key${key.toUpperCase()}`, [modifier]: true }), command);
      }
    }
  }
});

test("Korean and unidentified keys use physical positions without overriding other Latin layouts", () => {
  for (const [key, code, command] of [["ㅊ", "KeyC", "copy"], ["ㅌ", "KeyX", "cut"], ["ㅍ", "KeyV", "paste"]] as const) {
    assert.equal(clipboardShortcut({ ...base, key, code, metaKey: true }), command);
    assert.equal(clipboardShortcut({ ...base, key: "Unidentified", code, metaKey: true }), command);
  }
  assert.equal(clipboardShortcut({ ...base, key: "q", code: "KeyC", metaKey: true }), null);
  assert.equal(clipboardShortcut({ ...base, key: "Q", code: "KeyV", ctrlKey: true }), null);
  assert.equal(clipboardShortcut({ ...base, key: "ㅊ", code: "KeyQ", metaKey: true }), null);
});

test("typing, composition and alternate modifier combinations remain native", () => {
  for (const key of ["c", "x", "v"]) {
    const event = { ...base, key, code: `Key${key.toUpperCase()}`, metaKey: true };
    assert.equal(clipboardShortcut({ ...event, metaKey: false }), null);
    assert.equal(clipboardShortcut({ ...event, altKey: true }), null);
    assert.equal(clipboardShortcut({ ...event, shiftKey: true }), null);
    assert.equal(clipboardShortcut({ ...event, isComposing: true }), null);
  }
});
