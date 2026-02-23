const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..');
const EXTENSION_JS_PATH = path.join(ROOT, 'extension.js');
const LANGUAGE_CONFIG_PATH = path.join(ROOT, 'language-configuration.json');
const GRAMMAR_PATH = path.join(ROOT, 'syntaxes', 'avr-asm.tmLanguage.json');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const PACKAGE_SCRIPT_PATH = path.join(ROOT, 'package-vsix.sh');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const VERSIONING_POLICY_PATH = path.join(REPO_ROOT, 'docs', 'VERSIONING.md');

const extensionSource = fs.readFileSync(EXTENSION_JS_PATH, 'utf8');

function extractFrozenArray(constName) {
  const regex = new RegExp(
    `const ${constName} = Object\\.freeze\\((\\[[\\s\\S]*?\\])\\);`
  );
  const match = regex.exec(extensionSource);
  assert.ok(match, `Missing Object.freeze array for ${constName}.`);
  const value = vm.runInNewContext(match[1], {});
  assert.ok(Array.isArray(value), `${constName} did not evaluate to an array.`);
  return value;
}

test('JSON assets are valid', () => {
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(LANGUAGE_CONFIG_PATH, 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(GRAMMAR_PATH, 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')));
});

test('instruction completion list stays aligned with grammar instruction regex', () => {
  const instructions = extractFrozenArray('AVR_INSTRUCTION_MNEMONICS').map((item) =>
    String(item).toLowerCase()
  );
  const grammar = JSON.parse(fs.readFileSync(GRAMMAR_PATH, 'utf8'));
  const pattern = grammar.repository.instructions.patterns[0].match;
  const grammarMatch = /\(\?:([^)]+)\)\\b$/.exec(pattern);

  assert.ok(grammarMatch, 'Could not parse grammar instruction regex.');
  const grammarInstructions = grammarMatch[1]
    .split('|')
    .map((item) => item.toLowerCase());

  assert.deepEqual(
    [...new Set(instructions)].sort(),
    [...new Set(grammarInstructions)].sort()
  );
});

test('register completion covers core AVR register names', () => {
  const registers = extractFrozenArray('AVR_REGISTER_NAMES');
  const registerSet = new Set(registers);

  for (let index = 0; index < 32; index += 1) {
    assert.ok(registerSet.has(`r${index}`), `Missing register r${index}.`);
  }

  for (const alias of ['x', 'y', 'z', 'xl', 'xh', 'yl', 'yh', 'zl', 'zh']) {
    assert.ok(registerSet.has(alias), `Missing register alias ${alias}.`);
  }

  assert.equal(registerSet.size, registers.length, 'Register list has duplicates.');
});

test('completion provider trigger characters include comma for operand completion', () => {
  const start = extensionSource.indexOf('registerCompletionItemProvider(');
  assert.notEqual(start, -1, 'Completion provider registration not found.');
  const snippet = extensionSource.slice(start, start + 500);

  assert.match(snippet, /'_'/);
  assert.match(snippet, /'\.'/);
  assert.match(snippet, /','/);
});

test('active target command is contributed and activated', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const activationEvents = packageJson.activationEvents || [];
  const commands = (packageJson.contributes && packageJson.contributes.commands) || [];
  const commandIds = commands.map((entry) => entry.command);

  assert.ok(activationEvents.includes('onCommand:avrAsmNavigator.showActiveTarget'));
  assert.ok(commandIds.includes('avrAsmNavigator.showActiveTarget'));
});

test('VSIX packaging script uses an explicit include whitelist', () => {
  const script = fs.readFileSync(PACKAGE_SCRIPT_PATH, 'utf8');

  assert.match(script, /PACKAGE_FILES=\(/);
  assert.match(script, /PACKAGE_DIRS=\(/);
  assert.doesNotMatch(script, /cp -R "\$\{ROOT_DIR\}\/\."/);
});

test('versioning policy exists and changelog includes the active package version', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const versioningPolicy = fs.readFileSync(VERSIONING_POLICY_PATH, 'utf8');
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.match(changelog, /^# Changelog/m);
  assert.match(changelog, new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, 'm'));

  assert.match(versioningPolicy, /^# Versioning and Releases/m);
  assert.match(versioningPolicy, /Semantic Versioning/i);
  assert.match(versioningPolicy, /tag/i);
});
