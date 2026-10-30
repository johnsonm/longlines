import { useEffect } from "react";
import { createRoutesFromChildren, matchRoutes, useLocation, useNavigationType } from "react-router";
import * as Sentry from "@sentry/react";
import type { Breadcrumb, BrowserOptions, ErrorEvent } from "@sentry/react";
import type { RootOptions } from "react-dom/client";

// @sentry/react does not re-export it from @sentry/core.
export type StreamedSpan = Parameters<NonNullable<BrowserOptions["beforeSendSpan"]>>[0];

/**
 * Sentry (@sentry/react) reports the web app's errors and page-load and
 * navigation traces to the longlines-web project. It stays off without a DSN,
 * so local development and tests send nothing.
 */
export interface SentryEnv {
  dsn: string;
  environment: string;
  release: string;
}

/**
 * Cuts the query string and hash off a URL, as `withoutQueryOrHash` does for
 * Analytics: recovery and confirmation links carry auth tokens in the hash and
 * PKCE codes in the query, the relay approval page a device code, and Sentry
 * records the page URL on every event, breadcrumb and span.
 */
export function cutUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

// A URL-shaped value: absolute, a path, or a span name such as "GET https://...".
const URL_VALUE = /^(?:[A-Z]+ )?(?:https?:\/\/|\/)/;
// Keys that hold only a query string or a fragment.
const DROPPED_KEY = /(?:^|\.)(?:query|fragment)$/;

function scrubValue(value: string): string {
  return URL_VALUE.test(value) ? cutUrl(value) : value;
}

/**
 * Cuts every URL-shaped string in breadcrumb data, trace data or span
 * attributes. Span attributes are either raw values or `{ value, type }`.
 */
function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const [key, value] of Object.entries(data)) {
    if (DROPPED_KEY.test(key)) delete data[key];
    else if (typeof value === "string") data[key] = scrubValue(value);
    else if (typeof value === "object" && value !== null && "value" in value && typeof value.value === "string") {
      data[key] = { ...value, value: scrubValue(value.value) };
    }
  }
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  scrubData(breadcrumb.data);
  if (breadcrumb.message) breadcrumb.message = scrubValue(breadcrumb.message);
  return breadcrumb;
}

export function scrubError(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    if (event.request.url) event.request.url = cutUrl(event.request.url);
    delete event.request.query_string;
  }
  scrubData(event.contexts?.trace?.data);
  event.breadcrumbs?.forEach(scrubBreadcrumb);
  return event;
}

/** Spans stream one by one in SDK 11 (`traceLifecycle: "stream"`), so this replaces `beforeSendTransaction`. */
export function scrubSpan(span: StreamedSpan): StreamedSpan {
  span.name = scrubValue(span.name);
  scrubData(span.attributes);
  return span;
}

export function sentryOptions(env: SentryEnv): BrowserOptions {
  return {
    dsn: env.dsn,
    environment: env.environment,
    release: env.release || undefined,
    // No IPs, cookies, headers, bodies or query strings: none of it helps
    // with an error, and the Supabase requests carry the session's tokens.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    integrations: [
      Sentry.reactRouterV7BrowserTracingIntegration({ useEffect, useLocation, useNavigationType, createRoutesFromChildren, matchRoutes }),
    ],
    // tracePropagationTargets stays at the SDK's default (this origin only),
    // so no sentry-trace or baggage header reaches Supabase's CORS checks.
    tracesSampleRate: env.environment === "production" ? 0.2 : 1.0,
    beforeSend: scrubError,
    beforeSendSpan: scrubSpan,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

/**
 * React 19 reports render errors to the root's handlers rather than to
 * window.onerror. They replace React's own console logging, so they are set
 * only while Sentry runs; without a DSN errors still reach the console.
 */
export function rootErrorHandlers(): RootOptions {
  if (!Sentry.isInitialized()) return {};
  return {
    onUncaughtError: Sentry.reactErrorHandler(),
    onCaughtError: Sentry.reactErrorHandler(),
    onRecoverableError: Sentry.reactErrorHandler(),
  };
}
