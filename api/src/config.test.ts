import { describe, expect, test } from 'bun:test';
import { legacyPackagesDirectory } from './config';

describe('legacy package directory fallback', () => {
  test('maps legacy piston data roots to the new package mount', () => {
    expect(legacyPackagesDirectory('/piston')).toBe('/pkgs');
    expect(legacyPackagesDirectory('/piston/')).toBe('/pkgs');
    expect(legacyPackagesDirectory('/piston/packages')).toBe('/pkgs');
  });

  test('preserves custom legacy data directories', () => {
    expect(legacyPackagesDirectory('/custom/data')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/custom/data/packages')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/')).toBe('/packages');
  });

  test('ignores empty legacy data directories', () => {
    expect(legacyPackagesDirectory(undefined)).toBeUndefined();
    expect(legacyPackagesDirectory('   ')).toBeUndefined();
  });
});
