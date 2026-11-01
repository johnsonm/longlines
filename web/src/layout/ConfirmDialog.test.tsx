import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Typography } from "@mui/material";
import { renderPage } from "../test/render";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

describe("ConfirmDialog", () => {
  it("shows the title, the body and the confirm label, and answers each button", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { user } = renderPage(
      <ConfirmDialog title="Clear the queue for Hook?" confirmLabel="Clear queue" confirmColor="warning" onCancel={onCancel} onConfirm={onConfirm}>
        <Typography>140 spots waiting to be sent will be dropped.</Typography>
      </ConfirmDialog>,
    );
    expect(screen.getByRole("dialog", { name: "Clear the queue for Hook?" })).toBeInTheDocument();
    expect(screen.getByText("140 spots waiting to be sent will be dropped.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear queue" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("is what ConfirmDeleteDialog renders, with its title, Delete and the undo line", async () => {
    const onConfirm = vi.fn();
    const { user } = renderPage(
      <ConfirmDeleteDialog name="Hook" onCancel={vi.fn()} onConfirm={onConfirm}>
        <Typography>No connections use this destination.</Typography>
      </ConfirmDeleteDialog>,
    );
    expect(screen.getByRole("dialog", { name: "Delete Hook?" })).toBeInTheDocument();
    expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
