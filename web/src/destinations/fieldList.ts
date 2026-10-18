// Ordered field picks, shared by the push and Discord editors: the list edits
// the pickers make and the option shape of their selects. Pure and generic
// over the field id; SQL checks every list again on save and renders it.

export interface FieldInfo<T extends string> {
  id: T;
  label: string;
}

export interface Option<T> {
  value: T;
  label: string;
}

/** The display name of `id` in `all`, or the id itself when `all` lacks it. */
export function labelOf<T extends string>(all: readonly FieldInfo<T>[], id: T): string {
  return all.find((f) => f.id === id)?.label ?? id;
}

/** Appends a field; the list is returned as is when it is full or already has the field. */
export function addField<T>(list: T[], field: T, max: number): T[] {
  if (list.length >= max || list.includes(field)) return list;
  return [...list, field];
}

/** Removes the field at `index`; the list is returned as is when that would take it below `min`. */
export function removeField<T>(list: T[], index: number, min = 0): T[] {
  if (index < 0 || index >= list.length || list.length <= min) return list;
  return list.filter((_, i) => i !== index);
}

/** Moves the field at `index` by `delta` places; the list is returned as is when that leaves it. */
export function moveField<T>(list: T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length || delta === 0) return list;
  const next = [...list];
  const [field] = next.splice(index, 1);
  next.splice(to, 0, field!);
  return next;
}

/** The fields a list can still take, in the order of `all`. */
export function unpickedFields<T extends string>(list: readonly T[], all: readonly FieldInfo<T>[]): FieldInfo<T>[] {
  return all.filter((f) => !list.includes(f.id));
}
