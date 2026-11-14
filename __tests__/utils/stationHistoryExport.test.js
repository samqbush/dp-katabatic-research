import { jest } from '@jest/globals';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const readDays = jest.fn();
const closePool = jest.fn();
jest.unstable_mockModule('@/scripts/lib/archive-store.mjs', () => ({
  readDays,
  closePool,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let directory;
let output;

async function runExport(extraArgs) {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  closePool.mockImplementationOnce(resolveClosed);
  process.argv = [
    process.execPath, 'scripts/export-station-history.mjs',
    '--station', 'dp-soda-lakes', '--out', output, ...extraArgs,
  ];
  jest.resetModules();
  await import('@/scripts/export-station-history.mjs');
  await closed;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'soda-history-export-'));
  output = join(directory, 'history.csv');
  readDays.mockReset().mockResolvedValue([{
    station: 'DP Soda Lakes',
    date: '2026-09-01',
    status: 'unobserved',
    reason: 'seasonal-shutdown',
    point_count: 0,
    points: [],
  }]);
  closePool.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  jest.restoreAllMocks();
  await unlink(output);
  await rmdir(directory);
});

it('refuses to overwrite an existing export when no-clobber is requested', async () => {
  await writeFile(output, 'keep this file\n', 'utf8');

  await runExport(['--no-clobber']);

  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EEXIST'));
  expect(await readFile(output, 'utf8')).toBe('keep this file\n');
  expect(readDays).toHaveBeenCalledWith('dp-soda-lakes', expect.objectContaining({
    consistentSnapshot: true,
  }));
});

it('preserves the existing overwrite behavior when no-clobber is not requested', async () => {
  await writeFile(output, 'old content\n', 'utf8');

  await runExport([]);

  expect(process.exitCode).toBe(originalExitCode);
  expect(await readFile(output, 'utf8')).toContain('station,local_date,day_status');
  expect(readDays).toHaveBeenCalledWith('dp-soda-lakes', expect.objectContaining({
    consistentSnapshot: true,
  }));
});
