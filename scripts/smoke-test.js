const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const files = [
  'package.json', 'render.yaml', '.env.example',
  'server/index.js', 'client/index.html', 'client/js/app.js',
  'client/js/icons.js', 'client/css/app.css', 'client/manifest.webmanifest', 'client/sw.js',
  'android/settings.gradle', 'android/build.gradle', 'android/app/build.gradle',
  'android/app/src/main/AndroidManifest.xml', 'android/app/src/main/java/com/mavryn/app/MainActivity.java'
];
for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), `Missing ${f}`);
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client/js/app.js'), 'utf8');
assert.ok(server.includes("MAX_ACCOUNTS = 10"));
assert.ok(server.includes("ADMIN_NAME = 'A'"));
assert.ok(server.includes("/api/auth/register"));
assert.ok(server.includes("/api/conversations/:id/messages"));
assert.ok(server.includes("/api/messages/:id/forward"));
assert.ok(server.includes("/api/calls"));
assert.ok(server.includes("/api/admin/stats"));
assert.ok(client.includes("forgot-name"));
assert.ok(client.includes("new-story"));
assert.ok(client.includes("start-video"));
assert.ok(!/main\.js/.test(fs.readFileSync(path.join(root, 'client/index.html'), 'utf8')));
console.log('Mavryn smoke checks: PASS');
