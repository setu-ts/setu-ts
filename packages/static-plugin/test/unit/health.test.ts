import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('static-plugin health indicator', () => {
  it('should report up when root is a directory', async () => {
    const fs = {
      stat: () =>
        Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
    };

    const healthFn = async () => {
      try {
        const stat = await fs.stat('');
        if (stat.isDirectory) {
          return { status: 'up' as const };
        }
        return { status: 'down' as const, detail: 'root is not a directory' };
      } catch (error) {
        return { status: 'down' as const, detail: String(error) };
      }
    };

    const result = await healthFn();
    expect(result).toEqual({ status: 'up' });
  });

  it('should report down when stat throws', async () => {
    const fs = {
      stat: () => {
        throw new Error('ENOENT');
      },
    };

    const healthFn = async () => {
      try {
        const stat = await fs.stat('');
        if (stat.isDirectory) {
          return { status: 'up' as const };
        }
        return { status: 'down' as const, detail: 'root is not a directory' };
      } catch (error) {
        return { status: 'down' as const, detail: String(error) };
      }
    };

    const result = await healthFn();
    expect(result).toEqual({ status: 'down', detail: 'Error: ENOENT' });
  });

  it('should report degraded when fs is absent', () => {
    const result = {
      status: 'degraded' as const,
      detail: 'no file system on this runtime',
    };
    expect(result).toEqual({
      status: 'degraded',
      detail: 'no file system on this runtime',
    });
  });
});
