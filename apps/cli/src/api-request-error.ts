export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function isStalePermissionResolution(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409 && error.code === "invalid_state";
}
