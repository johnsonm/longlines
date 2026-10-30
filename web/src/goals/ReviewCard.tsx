import { useState } from "react";
import { Box, Button, Card, CardContent, Divider, ListItemText, Menu, MenuItem, Stack, Typography } from "@mui/material";
import { reviewDetail, reviewTitle } from "./model";
import type { GoalReview, GoalReviewCandidate } from "./types";

interface Props {
  reviews: GoalReview[];
  /** The parks still needed on the list: what "Pick park" offers when no spot was near the contact. */
  neededParks: GoalReviewCandidate[];
  now: Date;
  busy: boolean;
  /** A reference picks the park; null is "Not a park contact". */
  onResolve: (id: string, reference: string | null) => void;
}

/**
 * "Needs a look": logged contacts whose park couldn't be told. Spots at several parks offer
 * Choose park (a menu of those parks); no spot near the contact offers Pick park (a menu of the
 * parks still needed). Either way, Not a park contact.
 */
export function ReviewCard({ reviews, neededParks, now, busy, onResolve }: Props) {
  const [menu, setMenu] = useState<{ el: HTMLElement; review: GoalReview } | null>(null);
  const options = menu ? (menu.review.candidates.length > 0 ? menu.review.candidates : neededParks) : [];

  const pick = (reference: string) => {
    if (menu) onResolve(menu.review.id, reference);
    setMenu(null);
  };

  return (
    <Card variant="outlined" component="section" aria-label="Needs a look">
      <CardContent>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <Typography variant="h6" component="h2">{`Needs a look · ${reviews.length}`}</Typography>
          <Typography variant="body2" color="text.secondary">Contacts we couldn't match to a park</Typography>
        </Stack>
        <Stack divider={<Divider />}>
          {reviews.map((r) => (
            <Stack
              key={r.id} direction="row" spacing={2} useFlexGap
              sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", py: 1.5 }}
            >
              <Box sx={{ flex: "1 1 320px", minWidth: 0 }}>
                <Typography>{reviewTitle(r)}</Typography>
                <Typography variant="body2" color="text.secondary">{reviewDetail(r, now)}</Typography>
              </Box>
              <Stack direction="row" spacing={1}>
                <Button
                  variant="outlined" size="small" disabled={busy}
                  onClick={(ev) => setMenu({ el: ev.currentTarget, review: r })}
                >
                  {r.candidates.length > 0 ? "Choose park" : "Pick park"}
                </Button>
                <Button size="small" disabled={busy} onClick={() => onResolve(r.id, null)}>Not a park contact</Button>
              </Stack>
            </Stack>
          ))}
        </Stack>
        <Menu anchorEl={menu?.el ?? null} open={menu !== null} onClose={() => setMenu(null)}>
          {options.map((c) => (
            <MenuItem key={c.reference} onClick={() => pick(c.reference)}>
              <ListItemText primary={c.name ?? c.reference} secondary={c.name ? c.reference : null} />
            </MenuItem>
          ))}
        </Menu>
      </CardContent>
    </Card>
  );
}
