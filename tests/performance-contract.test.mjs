import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/service.js', import.meta.url), 'utf8');
const historyRepository = await readFile(new URL('../src/infrastructure/history/cached-history-repository.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../supabase/functions/app-api/index.ts', import.meta.url), 'utf8');
const apiActions = await readFile(new URL('../supabase/functions/_shared/application/app-api-actions.js', import.meta.url), 'utf8');
const userStateRepository = await readFile(new URL('../supabase/functions/_shared/infrastructure/supabase/user-state-repository.js', import.meta.url), 'utf8');
const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));

test('state saves return only the new version instead of re-querying the complete state', () => {
  const replaceBlock = apiActions.slice(apiActions.indexOf("if (action === 'replace-state')"), apiActions.indexOf("if (action === 'test-notification')"));
  assert.match(replaceBlock, /version: await userStateRepository\.replace/);
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

test('frontend deduplicates overlapping reads and simultaneous state saves', () => {
  assert.match(service, /this\.bootstrapRequest/);
  assert.match(service, /CachedHistoryRepository/);
  assert.match(historyRepository, /this\.requests = new Map\(\)/);
  assert.match(historyRepository, /this\.requests\.has\(key\)/);
  assert.match(app, /let commitInProgress = false/);
  assert.match(app, /if \(commitInProgress\)/);
  assert.match(app, /finally \{[\s\S]*commitInProgress = false/);
});

test('existing profiles avoid repeated default-data upserts', () => {
  const ensureBlock = userStateRepository.slice(userStateRepository.indexOf('async ensureProfile'), userStateRepository.indexOf('async getState'));
  assert.match(ensureBlock, /profileCache\.get\(lineUser\.sub\)/);
  assert.match(ensureBlock, /\.eq\('line_user_id', lineUser\.sub\)[\s\S]*\.maybeSingle\(\)/);
  assert.match(ensureBlock, /if \(existing\)[\s\S]*return profile/);
  assert.ok(ensureBlock.indexOf('if (existing)') < ensureBlock.indexOf("from('user_settings').upsert"));
});

test('production build omits source maps and immutable hashed assets are cached', () => {
  assert.match(vite, /sourcemap: false/);
  const assetRule = vercel.headers.find((rule) => rule.source === '/assets/(.*)');
  assert.ok(assetRule);
  assert.equal(assetRule.headers.find((header) => header.key === 'Cache-Control')?.value, 'public, max-age=31536000, immutable');
});
