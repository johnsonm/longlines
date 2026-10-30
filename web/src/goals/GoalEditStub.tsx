import { Breadcrumbs, Link, Stack, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router";
import { PageTitle } from "../layout/PageTitle";

/**
 * /goals/new and /goals/:id/edit until the edit page lands (goals PR 5 replaces
 * this file): a title and the way back.
 */
export function GoalEditStub({ id }: { id: string | null }) {
  const back = id ? `/goals/${id}` : "/goals";
  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/goals" underline="hover" color="inherit">Goals</Link>
        <Typography color="text.primary">{id ? "Edit" : "New"}</Typography>
      </Breadcrumbs>
      <PageTitle>{id ? "Edit goal" : "Add goal"}</PageTitle>
      <Typography color="text.secondary">
        Editing goals is coming soon. <Link component={RouterLink} to={back}>Go back</Link>
      </Typography>
    </Stack>
  );
}
