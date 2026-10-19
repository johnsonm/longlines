import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { FieldPicker, type FieldPickerProps } from "./FieldPicker";
import type { FieldInfo } from "./fieldList";

type F = "a" | "b" | "c";
const ALL: FieldInfo<F>[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
];

/** The picker with its list held in state, as the editors hold it; onChange is spied. */
function Harness(props: Partial<FieldPickerProps<F>> & { initial: F[]; spy: (f: F[]) => void }) {
  const { initial, spy, ...rest } = props;
  const [fields, setFields] = useState<F[]>(initial);
  return (
    <FieldPicker<F>
      heading="Included, in this order" all={ALL} min={1} max={3} helper="Comment is untrusted." {...rest} fields={fields}
      onChange={(next) => {
        spy(next);
        setFields(next);
      }}
    />
  );
}

function render(props: Partial<FieldPickerProps<F>> & { initial: F[] }) {
  const spy = vi.fn();
  const r = renderPage(<Harness spy={spy} {...props} />);
  return { ...r, spy, group: screen.getByRole("group", { name: "Included, in this order" }) };
}

describe("FieldPicker", () => {
  it("adds through a select by default, with no keys or chips", async () => {
    const { user, group, spy } = render({ initial: ["b"] });
    expect(within(group).queryByText("Not included")).not.toBeInTheDocument();
    expect(group.querySelector("code")).toBeNull();
    await user.click(within(group).getByRole("combobox", { name: "Add a field" }));
    await user.click(screen.getByRole("option", { name: "Charlie" }));
    expect(spy).toHaveBeenLastCalledWith(["b", "c"]);
    expect(within(group).getByText("Comment is untrusted.")).toBeInTheDocument();
  });

  it("shows each row's key in monospace with keyOf", () => {
    const { group } = render({ initial: ["a", "c"], keyOf: (id) => `${id}_key` });
    expect([...group.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["a_key", "c_key"]);
  });

  it("adds through Not included chips, in the catalog's order", async () => {
    const { user, group, spy } = render({ initial: ["b"], addAs: "chips" });
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(group).getByText("Not included")).toBeInTheDocument();
    const chips = within(group).getAllByRole("button", { name: /^Add / });
    expect(chips.map((c) => c.textContent)).toEqual(["+ Alpha", "+ Charlie"]);
    await user.click(within(group).getByRole("button", { name: "Add Charlie" }));
    expect(spy).toHaveBeenLastCalledWith(["b", "c"]);
    expect(within(group).queryByRole("button", { name: "Add Charlie" })).not.toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Remove Charlie" })).toBeInTheDocument();
  });

  it("hides the Not included heading and chips once every field is included, keeping the helper", async () => {
    const { user, group } = render({ initial: ["a", "b"], addAs: "chips" });
    await user.click(within(group).getByRole("button", { name: "Add Charlie" }));
    expect(within(group).queryByText("Not included")).not.toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
    expect(within(group).getByText("Comment is untrusted.")).toBeInTheDocument();
    // Removing one brings them back.
    await user.click(within(group).getByRole("button", { name: "Remove Alpha" }));
    expect(within(group).getByText("Not included")).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Add Alpha" })).toBeInTheDocument();
  });

  it("disables the chips while the list is full", () => {
    const { group } = render({ initial: ["a", "b"], addAs: "chips", max: 2 });
    expect(within(group).getByRole("button", { name: "Add Charlie" })).toHaveAttribute("aria-disabled", "true");
  });
});
