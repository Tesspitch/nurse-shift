import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/service.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../supabase/functions/app-api/index.ts', import.meta.url), 'utf8');
const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));

test('state saves return only the new version instead of re-querying the complete state', () => {
  const replaceBlock = api.slice(api.indexOf("if (action === 'replace-state')"), api.indexOf("if (action === 'test-notification')"));
  assert.match(replaceBlock, /data: \{ version: Number\(version\) \}/);
  assert.doesNotMatch(replaceBlock, /getState\(/);
  assert.match(service, /result\?\.settings[\s\S]+version: Number\(result\?\.version/);
});

test('LIFF initialization is shared and active-screen rendering avoids hidden-screen work', () => {
  assert.match(service, /let lineInitializationPromise/);
  assert.match(service, /if \(!lineInitializationPromise\) lineInitializationPromise = initializeLine\(\)/);
  const renderBlock = app.slice(app.indexOf('function renderAll()'), app.indexOf('const screenMeta'));
  assert.match(renderBlock, /renderScreen\(activeScreenName\(\), payroll\)/);
  assert.doesNotMatch(renderBlock, /renderHome\(|renderCalendar\(|renderFinance\(|renderSettings\(|renderSlip\(/);
});

test('production build omits source maps and immutable hashed assets are cached', () => {
  assert.match(vite, /sourcemap: false/);
  const assetRule = vercel.headers.find((rule) => rule.source === '/assets/(.*)');
  assert.ok(assetRule);
  assert.equal(assetRule.headers.find((header) => header.key === 'Cache-Control')?.value, 'public, max-age=31536000, immutable');
});
