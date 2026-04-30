/**
 * Standard error envelope. Every JSON error response should look like:
 *
 *   { "error": { "code": "<machine_code>", "message": "<human_message>", "detail"?: "...", "retry_after"?: 30 } }
 *
 * This is a pragmatic subset of RFC 7807 (we don't bother with `type` URIs
 * or `instance` URIs for a demo). New code uses `errBody`; old call sites
 * are being migrated.
 */

export interface ApiError {
  code: string;
  message: string;
  detail?: string;
  retry_after?: number;
}

export function errBody(err: ApiError): { error: ApiError } {
  return { error: err };
}

export const codes = {
  invalid_input: "invalid_input",
  not_found: "not_found",
  conflict: "conflict",
  forbidden: "forbidden",
  unauthorized: "unauthorized",
  gone: "gone",
  rate_limited: "rate_limited",
  upstream_unavailable: "upstream_unavailable",
  internal: "internal",
} as const;
