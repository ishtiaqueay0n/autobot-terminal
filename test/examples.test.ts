import { describe, expect, it } from 'vitest';
import { fillExample } from '../src/shared/examples';

describe('fillExample', () => {
  it('removes placeholder markers and selects the first one', () => {
    expect(fillExample('tar cf {{target.tar}} {{file1}} {{file2}}')).toEqual({
      text: 'tar cf target.tar file1 file2',
      select: [7, 17],
    });
  });

  it('takes the first option alternative and does not select it', () => {
    expect(fillExample('rm {{[-r|--recursive]}} {{path/to/dir}}')).toEqual({ text: 'rm -r path/to/dir', select: [6, 17] });
  });

  it('leaves commands without placeholders alone', () => {
    expect(fillExample('git status')).toEqual({ text: 'git status', select: null });
  });
});
