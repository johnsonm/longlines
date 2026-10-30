import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import type { ErrorEvent } from "@sentry/react";
import { cutUrl, rootErrorHandlers, scrubBreadcrumb, scrubError, scrubSpan, sentryOptions, type StreamedSpan } from "./sentry";

vi.mock("@sentry/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@sentry/react")>(),
  isInitialized: vi.fn(() => false),
}));

const env = { dsn: "https://key@o1.ingest.us.sentry.io/1", environment: "production", release: "abc123" };

afterEach(() => vi.mocked(Sentry.isInitialized).mockReturnValue(false));

describe("cutUrl", () => {
  it("drops the query string and hash", () => {
    expect(cutUrl("https://longlines.io/set-password#access_token=a&refresh_token=r")).toBe("https://longlines.io/set-password");
    expect(cutUrl("/relay/approve?code=ABCD-EFGH")).toBe("/relay/approve");
    expect(cutUrl("https://longlines.io/stats")).toBe("https://longlines.io/stats");
  });
});

describe("scrubBreadcrumb", () => {
  it("cuts navigation and request URLs and drops query and fragment keys", () => {
    expect(scrubBreadcrumb({
      category: "navigation",
      data: { from: "/signin?next=x", to: "/set-password#access_token=a" },
    })).toEqual({ category: "navigation", data: { from: "/signin", to: "/set-password" } });
    expect(scrubBreadcrumb({
      category: "fetch",
      message: "GET https://x.supabase.co/rest/v1/profiles?select=*",
      data: { url: "https://x.supabase.co/rest/v1/profiles?select=*", "http.query": "?select=*", status_code: 200 },
    })).toEqual({
      category: "fetch",
      message: "GET https://x.supabase.co/rest/v1/profiles",
      data: { url: "https://x.supabase.co/rest/v1/profiles", status_code: 200 },
    });
    expect(scrubBreadcrumb({ category: "ui.click" })).toEqual({ category: "ui.click" });
  });
});

describe("scrubError", () => {
  it("cuts the page URL, drops the query string and scrubs the breadcrumbs", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: { url: "https://longlines.io/reset-password?code=pkce#x", query_string: "code=pkce" },
      contexts: { trace: { trace_id: "t", span_id: "s", data: { "url.full": "https://longlines.io/a#access_token=x" } } },
      breadcrumbs: [{ category: "navigation", data: { from: "/", to: "/relay/approve?code=ABCD" } }],
    };
    expect(scrubError(event)).toEqual({
      type: undefined,
      request: { url: "https://longlines.io/reset-password" },
      contexts: { trace: { trace_id: "t", span_id: "s", data: { "url.full": "https://longlines.io/a" } } },
      breadcrumbs: [{ category: "navigation", data: { from: "/", to: "/relay/approve" } }],
    });
    expect(scrubError({ type: undefined })).toEqual({ type: undefined });
  });
});

describe("scrubSpan", () => {
  it("cuts the span name and every URL-shaped attribute, raw or typed, and drops query and fragment attributes", () => {
    const span: StreamedSpan = {
      trace_id: "t",
      span_id: "s",
      name: "GET https://x.supabase.co/functions/v1/band-map?x=1",
      start_timestamp: 0,
      status: "ok",
      is_segment: false,
      attributes: {
        "url.full": "https://x.supabase.co/functions/v1/band-map?x=1",
        "sentry.segment.name": { value: "/relay/approve?code=ABCD", type: "string" },
        "url.query": "?x=1",
        "http.fragment": "#access_token=a",
        "sentry.op": "http.client",
        "http.response.status_code": 200,
        "sentry.sample_rate": { value: 1, type: "double" },
      },
    };
    expect(scrubSpan(span)).toEqual({
      trace_id: "t",
      span_id: "s",
      name: "GET https://x.supabase.co/functions/v1/band-map",
      start_timestamp: 0,
      status: "ok",
      is_segment: false,
      attributes: {
        "url.full": "https://x.supabase.co/functions/v1/band-map",
        "sentry.segment.name": { value: "/relay/approve", type: "string" },
        "sentry.op": "http.client",
        "http.response.status_code": 200,
        "sentry.sample_rate": { value: 1, type: "double" },
      },
    });
  });

  it("leaves a name that is not a URL alone", () => {
    const span: StreamedSpan = { trace_id: "t", span_id: "s", name: "Why? Because.", start_timestamp: 0, status: "ok", is_segment: true, attributes: {} };
    expect(scrubSpan(span).name).toBe("Why? Because.");
  });
});

describe("sentryOptions", () => {
  it("collects no user data and samples a fifth of production traces", () => {
    const options = sentryOptions(env);
    expect(options).toMatchObject({
      dsn: env.dsn,
      environment: "production",
      release: "abc123",
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      tracesSampleRate: 0.2,
      beforeSend: scrubError,
      beforeSendSpan: scrubSpan,
      beforeBreadcrumb: scrubBreadcrumb,
    });
    expect(options.tracePropagationTargets).toBeUndefined();
    expect(options.integrations).toHaveLength(1);
  });

  it("traces everything outside production and leaves an empty release unset", () => {
    const options = sentryOptions({ ...env, environment: "preview", release: "" });
    expect(options.tracesSampleRate).toBe(1);
    expect(options.release).toBeUndefined();
  });
});

describe("rootErrorHandlers", () => {
  it("leaves React's own handlers alone while Sentry is off", () => {
    expect(rootErrorHandlers()).toEqual({});
  });

  it("reports every kind of root error once Sentry runs", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    expect(Object.keys(rootErrorHandlers()).sort()).toEqual(["onCaughtError", "onRecoverableError", "onUncaughtError"]);
  });
});
