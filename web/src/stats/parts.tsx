// Building blocks shared by the Stats page and callsign profiles.

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, Typography } from "@mui/material";

// Shared by every grid: no menus, filters, selection, footer or sorting. It lives
// beside the components it is used with; fast refresh just reloads this file whole.
// oxlint-disable-next-line react/only-export-components
export const GRID = {
  disableColumnMenu: true,
  disableColumnFilter: true,
  disableColumnSelector: true,
  disableRowSelectionOnClick: true,
  hideFooter: true,
  density: "compact",
  autoHeight: true,
} as const;

/** A figure card; `small` sets a long value (a date) a size down, as phones draw it. */
export function Kpi({ label, value, detail, small = false }: { label: string; value: string; detail: ReactNode; small?: boolean }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary">{label}</Typography>
        <Typography variant={small ? "h5" : "h4"} component="div">{value}</Typography>
        <Typography variant="body2" color="text.secondary">{detail}</Typography>
      </CardContent>
    </Card>
  );
}

export function ChartCard({ title, subheader, children }: { title: string; subheader?: string; children: ReactNode }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardHeader title={title} subheader={subheader} slotProps={{ title: { variant: "h6" } }} />
      <CardContent sx={{ pt: 0 }}>{children}</CardContent>
    </Card>
  );
}
