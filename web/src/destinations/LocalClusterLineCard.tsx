import { Box, Card, CardContent, CardHeader, Checkbox, FormControlLabel, Stack, Typography } from "@mui/material";
import type { LocalClusterField } from "../lib/api";
import { FieldPicker } from "./FieldPicker";
import { FIELD_HELP, LOCAL_CLUSTER_FIELDS, MAX_FIELDS } from "./localClusterModel";

export interface LocalClusterLineCardProps {
  fields: LocalClusterField[];
  onChange: (fields: LocalClusterField[]) => void;
}

/**
 * The Local DX cluster editor's Spot line card: the mode always leads the
 * comment, then the picked fields in order. SQL renders the line
 * (local_cluster_spot_fields); this only picks and orders the fields.
 */
export function LocalClusterLineCard({ fields, onChange }: LocalClusterLineCardProps) {
  return (
    <Card variant="outlined">
      <CardHeader
        title="Spot line" subheader="Every spot is sent as a standard DX cluster line. Choose what goes in its comment and in what order."
        slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={2}>
          <FormControlLabel
            control={<Checkbox checked disabled />} sx={{ alignItems: "flex-start", m: 0 }}
            slotProps={{ typography: { component: "div" } }}
            label={
              <Box sx={{ pt: 1 }}>
                <Typography>Mode</Typography>
                <Typography variant="body2" color="text.secondary">Always included. Some logging software hides spots without a mode.</Typography>
              </Box>
            }
          />
          <FieldPicker
            heading="Comment" fields={fields} all={LOCAL_CLUSTER_FIELDS} min={0} max={MAX_FIELDS} addAs="chips"
            helpOf={(id) => FIELD_HELP[id]} onChange={onChange}
          />
        </Stack>
      </CardContent>
    </Card>
  );
}
