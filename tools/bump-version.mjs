// Bump the Chrome extension version across the three files that must stay in
// lockstep: package.json, extension/manifest.json, and package-lock.json.
// The servers/ are versioned independently and is left alone.
//
//   node tools/bump-version.mjs [patch|minor|major] [--dry]
//
// package.json is the source of truth for the current version. We then replace
// only the fields whose value equals that exact version, so the many dependency
// "version" fields in package-lock.json are never touched (no dependency shares
// the project's version). Targeted string replacement keeps formatting intact.
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => p.replace(root + '/', '');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const type = args.find((a) => !a.startsWith('-')) || 'patch';

if (!['patch', 'minor', 'major'].includes(type)) {
  console.error(`Unknown bump type "${type}". Use patch, minor, or major.`);
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const current = readFileSync(pkgPath, 'utf8').match(/"version":\s*"(\d+\.\d+\.\d+)"/)?.[1];
if (!current) {
  console.error('Could not read a version from package.json.');
  process.exit(1);
}

const [maj, min, pat] = current.split('.').map(Number);
const next =
  type === 'major' ? `${maj + 1}.0.0` :
  type === 'minor' ? `${maj}.${min + 1}.0` :
  `${maj}.${min}.${pat + 1}`;

const oldField = `"version": "${current}"`;
const newField = `"version": "${next}"`;

// Each file plus how many fields at the *current* version it must contain.
const targets = [
  { path: pkgPath, expect: 1 },
  { path: join(root, 'extension', 'manifest.json'), expect: 1 },
  { path: join(root, 'package-lock.json'), expect: 2 }, // root + packages[""]
];

// Validate before writing anything: every file must hold exactly the expected
// number of fields at the current version (catches drift between the files).
for (const t of targets) {
  t.text = readFileSync(t.path, 'utf8');
  t.hits = t.text.split(oldField).length - 1;
  if (t.hits !== t.expect) {
    const present = [...new Set([...t.text.matchAll(/"version":\s*"(\d+\.\d+\.\d+)"/g)].map((m) => m[1]))];
    console.error(
      `${rel(t.path)}: expected ${t.expect} field(s) at ${current}, found ${t.hits}.\n` +
      `  Versions present: ${present.join(', ')}. Reconcile the files first.`
    );
    process.exit(1);
  }
}

console.log(`${dry ? '[dry-run] ' : ''}${current} → ${next}`);
for (const t of targets) {
  console.log(`  ${rel(t.path)}  (${t.hits} field${t.hits === 1 ? '' : 's'})`);
  if (!dry) writeFileSync(t.path, t.text.replaceAll(oldField, newField));
}
if (dry) console.log('No files written (--dry).');
