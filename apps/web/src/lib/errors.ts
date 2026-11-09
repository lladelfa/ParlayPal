export type ApiErrorCode =
  | "INVALID_SPORT_KEY"
  | "STREAM_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | (string & {});

export interface ProblemDetailsPayload {
  error: {
    code: ApiErrorCode;
    message: string;
    retry_after: number;
  };
}

export function buildProblemDetails(
  code: ApiErrorCode,
  message: string,
  retryAfter: number = 60,
): ProblemDetailsPayload {
  return {
    error: {
      code,
      message,
      retry_after: retryAfter,
    },
  };
}

export function problemDetailsResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  retryAfter: number = 60,
): Response {
  const payload = buildProblemDetails(code, message, retryAfter);
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(retryAfter),
    },
  });
}
