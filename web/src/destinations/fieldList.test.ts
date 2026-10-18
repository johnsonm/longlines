import { describe, expect, it } from "vitest";
import { addField, labelOf, moveField, removeField, unpickedFields, type FieldInfo } from "./fieldList";

type F = "a" | "b" | "c" | "d";
const ALL: FieldInfo<F>[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
  { id: "d", label: "Delta" },
];
const LIST: F[] = ["c", "a"];

describe("fieldList", () => {
  it("adds a field until the list is full and never twice", () => {
    expect(addField(LIST, "b", 3)).toEqual(["c", "a", "b"]);
    expect(addField(LIST, "a", 3)).toBe(LIST);
    expect(addField(LIST, "b", 2)).toBe(LIST);
    expect(addField<F>([], "d", 1)).toEqual(["d"]);
  });

  it("removes by index but not below the minimum or out of range", () => {
    expect(removeField(LIST, 0)).toEqual(["a"]);
    expect(removeField(LIST, 1, 2)).toBe(LIST);
    expect(removeField(LIST, -1)).toBe(LIST);
    expect(removeField(LIST, 2)).toBe(LIST);
  });

  it("moves a field and refuses to move past the ends", () => {
    expect(moveField(LIST, 0, 1)).toEqual(["a", "c"]);
    expect(moveField(LIST, 1, -1)).toEqual(["a", "c"]);
    expect(moveField(LIST, 0, -1)).toBe(LIST);
    expect(moveField(LIST, 1, 1)).toBe(LIST);
    expect(moveField(LIST, 0, 0)).toBe(LIST);
    expect(moveField(LIST, 5, -1)).toBe(LIST);
  });

  it("lists the unpicked fields in the order of the full list", () => {
    expect(unpickedFields(LIST, ALL).map((f) => f.id)).toEqual(["b", "d"]);
    expect(unpickedFields(["a", "b", "c", "d"], ALL)).toEqual([]);
  });

  it("labels a field from the full list, or by its id", () => {
    expect(labelOf(ALL, "c")).toBe("Charlie");
    expect(labelOf(ALL, "z" as F)).toBe("z");
  });
});
