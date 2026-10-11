/**
 * Read a clipsfarm setting, accepting the former CLIPSWARM_ spelling as a
 * compatibility alias. New names win when both are set.
 */
export function configEnv(name: string): string | undefined {
  const current = process.env[name];
  if (current !== undefined) return current;
  const legacy = name.startsWith("CLIPSFARM_") ? name.replace(/^CLIPSFARM_/, "CLIPSWARM_") : undefined;
  return legacy ? process.env[legacy] : undefined;
}

/** The env key whose value is forwarded to a scheduled child process. */
export function configuredEnvName(name: string): string | undefined {
  if (process.env[name] !== undefined) return name;
  const legacy = name.startsWith("CLIPSFARM_") ? name.replace(/^CLIPSFARM_/, "CLIPSWARM_") : undefined;
  return legacy && process.env[legacy] !== undefined ? legacy : undefined;
}
