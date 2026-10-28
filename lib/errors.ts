import { ZodError } from "zod";

/** Consistent JSON error shape for every API route: { error: { code, message } }. */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** A required environment variable / integration is not configured. */
export class ConfigError extends AppError {
  constructor(public missing: string[]) {
    super(
      "CONFIG_MISSING",
      `Not configured: ${missing.join(", ")}. See SETUP_CHECKLIST.md.`,
      503,
      { missing },
    );
    this.name = "ConfigError";
  }
}

export const unauthorized = () => new AppError("UNAUTHORIZED", "Please sign in.", 401);
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found.`, 404);
export const planLimit = (message: string, details?: unknown) =>
  new AppError("PLAN_LIMIT", message, 403, details);

export function toErrorBody(err: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
    };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return {
      status: 400,
      body: {
        error: {
          code: "VALIDATION",
          message: `${where}${first?.message ?? "Invalid input"}`,
          details: err.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
    };
  }
  console.error("[api] unhandled error", err);
  return { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong on our side." } } };
}

export function errorResponse(err: unknown): Response {
  const { status, body } = toErrorBody(err);
  return Response.json(body, { status });
}
