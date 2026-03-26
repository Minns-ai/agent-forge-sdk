import { describe, it, expect } from 'vitest';
import { StateBackend } from '../../src/middleware/backend/state-backend.js';

describe('StateBackend', () => {
  it('should write and read files', async () => {
    const backend = new StateBackend();
    await backend.write('/test.txt', 'hello world');
    const result = await backend.read('/test.txt');
    expect(result.content).toBe('hello world');
    expect(result.error).toBeNull();
  });

  it('should return error for missing files', async () => {
    const backend = new StateBackend();
    const result = await backend.read('/missing.txt');
    expect(result.content).toBeNull();
    expect(result.error).toBe('file_not_found');
  });

  it('should pre-populate files from constructor', async () => {
    const backend = new StateBackend({
      files: { '/config.json': '{"key":"value"}' },
    });
    const result = await backend.read('/config.json');
    expect(result.content).toBe('{"key":"value"}');
  });

  it('should list directory entries', async () => {
    const backend = new StateBackend({
      files: {
        '/src/a.ts': 'a',
        '/src/b.ts': 'b',
        '/src/lib/c.ts': 'c',
      },
    });
    const result = await backend.ls('/src');
    expect(result.error).toBeNull();
    expect(result.entries).toHaveLength(3); // a.ts, b.ts, lib/
    const names = result.entries!.map(e => e.path);
    expect(names).toContain('/src/a.ts');
    expect(names).toContain('/src/b.ts');
    expect(names).toContain('/src/lib');
  });

  it('should glob files', async () => {
    const backend = new StateBackend({
      files: {
        '/src/index.ts': 'code',
        '/src/utils.ts': 'code',
        '/src/styles.css': 'css',
      },
    });
    const result = await backend.glob('*.ts', '/src');
    expect(result.matches).toHaveLength(2);
  });

  it('should grep file contents', async () => {
    const backend = new StateBackend({
      files: {
        '/a.ts': 'line 1\nfindme here\nline 3',
        '/b.ts': 'nothing here',
      },
    });
    const result = await backend.grep('findme');
    expect(result.matches).toHaveLength(1);
    expect(result.matches![0].path).toBe('/a.ts');
    expect(result.matches![0].line).toBe(2);
  });

  it('should edit files', async () => {
    const backend = new StateBackend();
    await backend.write('/test.txt', 'hello world');
    const result = await backend.edit('/test.txt', 'world', 'universe');
    expect(result.success).toBe(true);
    expect(result.occurrences).toBe(1);

    const content = await backend.read('/test.txt');
    expect(content.content).toBe('hello universe');
  });

  it('should check file existence', async () => {
    const backend = new StateBackend({
      files: { '/exists.txt': 'yes' },
    });
    expect((await backend.exists('/exists.txt')).exists).toBe(true);
    expect((await backend.exists('/nope.txt')).exists).toBe(false);
  });

  it('should delete files', async () => {
    const backend = new StateBackend({
      files: { '/delete-me.txt': 'bye' },
    });
    const result = await backend.delete('/delete-me.txt');
    expect(result.success).toBe(true);
    expect((await backend.exists('/delete-me.txt')).exists).toBe(false);
  });

  it('should read with offset and limit', async () => {
    const backend = new StateBackend();
    await backend.write('/lines.txt', 'line1\nline2\nline3\nline4\nline5');
    const result = await backend.read('/lines.txt', { offset: 1, limit: 2 });
    expect(result.content).toBe('line2\nline3');
  });

  it('should normalize paths', async () => {
    const backend = new StateBackend();
    await backend.write('/a/../b/./c.txt', 'normalized');
    const result = await backend.read('/b/c.txt');
    expect(result.content).toBe('normalized');
  });
});
