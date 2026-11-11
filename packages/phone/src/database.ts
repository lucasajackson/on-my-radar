/** Validate before interpolating an environment-supplied SQL identifier. */
export function scratchDatabase(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      'OMR_PHONE_DB must be a lowercase PostgreSQL identifier of at most 63 characters.',
    );
  }
  if (['on-my-radar', 'onmyradar', 'postgres', 'template0', 'template1'].includes(name)) {
    throw new Error(`refusing to drop "${name}" — choose a dedicated scratch database`);
  }
  return name;
}
