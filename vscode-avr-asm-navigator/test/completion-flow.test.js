const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_JS_PATH = path.join(ROOT, 'extension.js');
const WORD_CHAR_REGEX = /[A-Za-z0-9_.$]/;

function createDisposable() {
  return { dispose() {} };
}

function createVscodeMock(configOverrides = {}) {
  const registrations = {
    completion: null
  };
  const configValues = {
    enableCompletion: true,
    enableInstructionCompletion: true,
    autoDetectMplabProject: false,
    maxCompletionItems: 41,
    maxHoverResults: 6,
    maxWorkspaceScanFiles: 40,
    maxWorkspaceSymbols: 80,
    maxReferenceResults: 100,
    includeDfpInWorkspaceSymbols: false,
    ...configOverrides
  };
  const outputLines = [];

  const vscodeMock = {
    CompletionItem: class CompletionItem {
      constructor(label, kind) {
        this.label = label;
        this.kind = kind;
      }
    },
    CompletionItemKind: {
      Variable: 6,
      Keyword: 14,
      Constant: 21
    },
    languages: {
      registerHoverProvider() {
        return createDisposable();
      },
      registerDefinitionProvider() {
        return createDisposable();
      },
      registerDocumentSymbolProvider() {
        return createDisposable();
      },
      registerReferenceProvider() {
        return createDisposable();
      },
      registerWorkspaceSymbolProvider() {
        return createDisposable();
      },
      registerCompletionItemProvider(_selector, provider, ...triggerCharacters) {
        registrations.completion = {
          provider,
          triggerCharacters
        };
        return createDisposable();
      }
    },
    commands: {
      registerCommand() {
        return createDisposable();
      }
    },
    window: {
      activeTextEditor: null,
      createOutputChannel() {
        return {
          appendLine(line) {
            outputLines.push(String(line));
          },
          show() {},
          dispose() {}
        };
      },
      showInformationMessage() {},
      showWarningMessage() {},
      showErrorMessage() {},
      showQuickPick: async () => null,
      showInputBox: async () => '',
      showTextDocument: async () => null
    },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      fs: {
        readDirectory: async () => [],
        readFile: async () => Buffer.from('')
      },
      getConfiguration(section) {
        assert.equal(section, 'avrAsmNavigator');
        return {
          get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(configValues, key)
              ? configValues[key]
              : fallback;
          }
        };
      },
      getWorkspaceFolder() {
        return null;
      },
      findFiles: async () => [],
      openTextDocument: async () => {
        throw new Error('openTextDocument should not be called in completion tests');
      },
      onDidChangeConfiguration() {
        return createDisposable();
      },
      onDidCloseTextDocument() {
        return createDisposable();
      },
      onDidSaveTextDocument() {
        return createDisposable();
      },
      onDidCreateFiles() {
        return createDisposable();
      },
      onDidDeleteFiles() {
        return createDisposable();
      },
      onDidRenameFiles() {
        return createDisposable();
      },
      onDidChangeWorkspaceFolders() {
        return createDisposable();
      }
    }
  };

  return {
    vscodeMock,
    registrations,
    outputLines
  };
}

function loadExtensionWithMock(vscodeMock) {
  const source = fs.readFileSync(EXTENSION_JS_PATH, 'utf8');
  const moduleRef = { exports: {} };
  const sandbox = {
    module: moduleRef,
    exports: moduleRef.exports,
    require(moduleName) {
      if (moduleName === 'vscode') {
        return vscodeMock;
      }
      return require(moduleName);
    },
    __dirname: path.dirname(EXTENSION_JS_PATH),
    __filename: EXTENSION_JS_PATH,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };

  vm.runInNewContext(source, sandbox, { filename: EXTENSION_JS_PATH });
  return moduleRef.exports;
}

function createDocument(text) {
  const lines = text.split(/\r?\n/);
  return {
    uri: {
      scheme: 'file',
      path: '/tmp/completion-test.S',
      fsPath: '/tmp/completion-test.S',
      toString() {
        return 'file:///tmp/completion-test.S';
      }
    },
    languageId: 'avr-asm',
    version: 1,
    getText(range) {
      if (!range) {
        return text;
      }
      if (range.start.line !== range.end.line) {
        throw new Error('Multiline range not supported in test document');
      }
      const line = lines[range.start.line] || '';
      return line.slice(range.start.character, range.end.character);
    },
    getWordRangeAtPosition(position, wordRegex) {
      const line = lines[position.line] || '';
      const cursor = Math.max(0, Math.min(position.character, line.length));

      let start = cursor;
      while (start > 0 && WORD_CHAR_REGEX.test(line[start - 1])) {
        start -= 1;
      }

      let end = cursor;
      while (end < line.length && WORD_CHAR_REGEX.test(line[end])) {
        end += 1;
      }

      if (start === end) {
        return null;
      }

      const word = line.slice(start, end);
      const exactWordRegex = new RegExp(`^${wordRegex.source}$`);
      if (!exactWordRegex.test(word)) {
        return null;
      }

      return {
        start: { line: position.line, character: start },
        end: { line: position.line, character: end }
      };
    }
  };
}

async function getCompletionsForLine(lineText, configOverrides = {}) {
  const { vscodeMock, registrations } = createVscodeMock(configOverrides);
  const extension = loadExtensionWithMock(vscodeMock);
  const context = { subscriptions: [] };
  extension.activate(context);

  assert.ok(registrations.completion, 'Completion provider was not registered.');
  const document = createDocument(lineText);
  const position = { line: 0, character: lineText.length };
  const token = { isCancellationRequested: false };
  const items = await registrations.completion.provider.provideCompletionItems(
    document,
    position,
    token
  );

  return {
    items: Array.isArray(items) ? items : [],
    triggerCharacters: registrations.completion.triggerCharacters
  };
}

function labelsFrom(items) {
  return items.map((item) => String(item.label).toLowerCase());
}

test('completion provider is triggered for comma-separated operand entry', async () => {
  const { triggerCharacters } = await getCompletionsForLine('add r16, ', {
    maxCompletionItems: 41
  });
  assert.ok(triggerCharacters.includes(','), 'Missing comma completion trigger.');
});

test('register completions are returned immediately after "add r16, "', async () => {
  const { items } = await getCompletionsForLine('add r16, ', {
    maxCompletionItems: 41
  });
  const labels = labelsFrom(items);

  assert.equal(items.length, 41);
  assert.ok(labels.includes('r0'));
  assert.ok(labels.includes('r16'));
  assert.ok(labels.includes('r31'));
  assert.ok(labels.includes('x'));
  assert.ok(labels.includes('zh'));
});

test('register completions narrow correctly for register prefixes', async () => {
  const { items } = await getCompletionsForLine('add r16, r1', {
    maxCompletionItems: 11
  });
  const labels = labelsFrom(items);

  assert.equal(items.length, 11);
  assert.ok(labels.includes('r1'));
  assert.ok(labels.includes('r10'));
  assert.ok(labels.includes('r19'));
  assert.ok(!labels.includes('r0'));
});

test('instruction completion keeps operand spacing for operand-taking mnemonics', async () => {
  const { items } = await getCompletionsForLine('ad', {
    maxCompletionItems: 1
  });

  assert.equal(items.length, 1);
  assert.equal(String(items[0].label).toLowerCase(), 'adc');
  assert.equal(items[0].insertText, 'adc ');
});
