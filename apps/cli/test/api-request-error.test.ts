import { describe, expect, test } from "bun:test";
import { ApiRequestError, isStalePermissionResolution } from "../src/api-request-error.ts";

describe("permission resolution API errors", () => {
  test("recognizes only the cancelled-permission conflict", () => {
    expect(isStalePermissionResolution(
      new ApiRequestError("Permission is no longer pending", 409, "invalid_state"),
    )).toBe(true);
    expect(isStalePermissionResolution(
      new ApiRequestError("unauthorized", 401, "unauthorized"),
    )).toBe(false);
    expect(isStalePermissionResolution(
      new ApiRequestError("conflict", 409, "different_code"),
    )).toBe(false);
    expect(isStalePermissionResolution(new Error("Permission is no longer pending"))).toBe(false);
  });
});
