export function reducedMotionEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const value = environment.DEMESNE_REDUCED_MOTION?.toLowerCase();
  return value === "1" || value === "true";
}
