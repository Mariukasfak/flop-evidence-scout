import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readRequired(relativePath) {
  const filePath = path.resolve(relativePath);
  assert.equal(fs.existsSync(filePath), true, `${relativePath} must exist`);
  return fs.readFileSync(filePath, 'utf8');
}

test('local UI exposes persistent conversation cards and one accessible Lithuanian chat form', () => {
  const html = readRequired('web/index.html');
  assert.match(html, /<html lang="lt">/);
  assert.match(html, /<form[^>]+id="chat-form"/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.match(html, /id="task-input"/);
  assert.match(html, /for="task-input"/);
  assert.doesNotMatch(html, /id="mode-select"|Demo taryba|be kvotų/i);
  assert.match(html, /Mokosi tik iš realių TriAgent paleidimų/i);
  assert.match(html, /id="new-chat-button"/);
  assert.match(html, /id="chat-list"/);
  assert.match(html, /Pokalbiai/);
  assert.match(html, /Naujas pokalbis/);
  assert.match(html, /id="agent-list"/);
  assert.match(html, /id="event-log"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/);
  assert.doesNotMatch(html, /<style/);
});

test('browser client creates and restores chats while consuming the run event stream', () => {
  const script = readRequired('web/app.js');
  assert.match(script, /fetch\(['"]\/api\/providers/);
  assert.match(script, /fetch\(['"]\/api\/chats/);
  assert.match(script, /\/messages/);
  assert.match(script, /new EventSource/);
  assert.match(script, /PROPOSAL/);
  assert.match(script, /CRITIQUE/);
  assert.match(script, /DELEGATION/);
  assert.match(script, /RUN_COMPLETED/);
  assert.match(script, /CLI rastas · auth netikrinta/);
  assert.match(script, /Numatytasis dirigentas/);
  assert.match(script, /payload\.assignments/);
  assert.match(script, /payload\.dissent/);
  assert.match(script, /decisionSource/);
  assert.match(script, /payload\.learning/);
  assert.match(script, /Tarybos svarstymas/);
  assert.match(script, /history\.replaceState|location\.hash/);
  assert.doesNotMatch(script, /worker-only|tik darbininkas|modeSelect|modeNote|\bdemo\b/i);
});

test('UI stylesheet contains responsive and reduced-motion behavior', () => {
  const css = readRequired('web/styles.css');
  assert.match(css, /@media\s*\(max-width:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});
