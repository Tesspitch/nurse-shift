import test from 'node:test';
import assert from 'node:assert/strict';
import { readNavigationIntent } from '../src/navigation.js';

test('reads supported rich-menu destinations', () => {
  assert.deepEqual(readNavigationIntent('?screen=calendar'), { screen: 'calendar', action: null });
  assert.deepEqual(readNavigationIntent('?action=add-shift'), { screen: null, action: 'add-shift' });
  assert.deepEqual(readNavigationIntent('?screen=settings'), { screen: 'settings', action: null });
});

test('ignores unknown destinations', () => {
  assert.deepEqual(readNavigationIntent('?screen=finance&action=unknown'), { screen: null, action: null });
});
