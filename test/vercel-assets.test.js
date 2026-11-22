const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareVercelAssets } = require('../scripts/prepare-vercel-assets');

test('Vercel asset build copies public pages and assets without exposing the waitlist page', (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-vercel-assets-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  prepareVercelAssets(outputDirectory);

  for (const page of ['index.html', 'signup.html', 'about.html', 'logistics.html']) {
    assert.equal(fs.existsSync(path.join(outputDirectory, page)), true);
  }
  assert.equal(fs.existsSync(path.join(outputDirectory, 'waitlist.html')), false);
  assert.equal(
    fs.existsSync(path.join(outputDirectory, 'assets', 'Google__G__Logo (1) 1.svg')),
    true,
  );
});
