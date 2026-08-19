import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CAPTION_CHARS, splitCaption } from './captions.ts';

test('long host copy is split into readable subtitle cards', () => {
  const input = '刚进直播间的朋友可以先看看正在进行的真实洗护操作，这段文字故意写得很长，用来确认字幕不会冲出三行安全区域。特殊材质需要员工先检查，退款和赔偿也必须由员工核实。';
  const chunks = splitCaption(input);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_CAPTION_CHARS));
  assert.equal(chunks.join('').replaceAll(' ', ''), input.replaceAll(' ', ''));
});

test('empty copy never creates a speech task', () => {
  assert.deepEqual(splitCaption('   '), []);
});
