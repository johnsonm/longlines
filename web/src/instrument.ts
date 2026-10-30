import * as Sentry from "@sentry/react";
import { sentryOptions } from "./lib/sentry";

// Imported first by main.tsx, so Sentry is set up before any other module runs.
const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "";
if (dsn) {
  Sentry.init(sentryOptions({
    dsn,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? "",
  }));
}
