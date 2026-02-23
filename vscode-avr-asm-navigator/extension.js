'use strict';

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const WORD_REGEX = /[A-Za-z_.$][A-Za-z0-9_.$]*/;
const LOCAL_LABEL_REGEX = /^\s*([A-Za-z_.$][A-Za-z0-9_.$]*)\s*:/;
const LOCAL_EQU_REGEX = /^\s*\.equ\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*=\s*(.+)$/i;
const LOCAL_SET_REGEX = /^\s*\.set\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*=\s*(.+)$/i;
const IDENTIFIER_CHAR_CLASS = 'A-Za-z0-9_.$';
const WORKSPACE_ASM_GLOB = '**/*.{S,s,asm,ASM,as,AS,inc,INC}';
const WORKSPACE_EXCLUDE_GLOB = '**/{_build,out,cmake,node_modules,.git}/**';

const DEFAULT_MAX_WORKSPACE_SCAN_FILES = 400;
const DEFAULT_MAX_WORKSPACE_SYMBOLS = 300;
const DEFAULT_MAX_REFERENCE_RESULTS = 500;

const DEFAULT_PACK_VENDOR = 'Microchip';

let cachedIndex = null;
let indexBuildPromise = null;
const localSymbolCache = new Map();

function getConfig() {
  return vscode.workspace.getConfiguration('avrAsmHints');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(directoryPath) {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listDirSafe(directoryPath) {
  try {
    return await fs.readdir(directoryPath);
  } catch {
    return [];
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function getConfiguredDfpPath() {
  return (getConfig().get('dfpPath', '') || '').trim();
}

function getConfiguredDevice() {
  return (getConfig().get('device', '') || '').trim();
}

function shouldAutoDetectMplabProject() {
  return Boolean(getConfig().get('autoDetectMplabProject', true));
}

function normalizeDeviceForLookup(deviceName) {
  return (deviceName || '').trim().toLowerCase();
}

function parseVersionParts(versionText) {
  return String(versionText || '')
    .split(/[^0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
}

function compareVersionLabels(leftVersion, rightVersion) {
  const leftParts = parseVersionParts(leftVersion);
  const rightParts = parseVersionParts(rightVersion);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < maxLength; i += 1) {
    const left = i < leftParts.length ? leftParts[i] : 0;
    const right = i < rightParts.length ? rightParts[i] : 0;
    if (left !== right) {
      return left - right;
    }
  }
  return String(leftVersion || '').localeCompare(String(rightVersion || ''));
}

function extractDeviceToken(deviceLowerName) {
  const match = /([0-9][0-9a-z]*)$/i.exec(deviceLowerName);
  if (match) {
    return match[1].toLowerCase();
  }
  return deviceLowerName.replace(/[^a-z0-9]/g, '');
}

function sortBySpecificity(fileNames) {
  return fileNames.slice().sort((a, b) => {
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a.localeCompare(b);
  });
}

async function detectMplabTarget() {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const folder of workspaceFolders) {
    const vscodeDir = path.join(folder.uri.fsPath, '.vscode');
    const files = await listDirSafe(vscodeDir);
    const mplabFiles = files
      .filter((file) => file.endsWith('.mplab.json'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of mplabFiles) {
      const fullPath = path.join(vscodeDir, file);
      const jsonText = await readTextIfExists(fullPath);
      if (!jsonText) {
        continue;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        continue;
      }

      const configurations = Array.isArray(parsed.configurations)
        ? parsed.configurations
        : [];
      const config = configurations[0] || {};
      const device =
        typeof config.device === 'string' ? config.device.trim() : '';
      const packs = Array.isArray(config.packs) ? config.packs : [];
      const packCandidate =
        packs.find(
          (pack) =>
            pack &&
            typeof pack.name === 'string' &&
            pack.name.toUpperCase().includes('DFP')
        ) || packs[0] || null;

      const pack = {
        vendor:
          packCandidate && typeof packCandidate.vendor === 'string'
            ? packCandidate.vendor
            : DEFAULT_PACK_VENDOR,
        name:
          packCandidate && typeof packCandidate.name === 'string'
            ? packCandidate.name
            : '',
        version:
          packCandidate && typeof packCandidate.version === 'string'
            ? packCandidate.version
            : ''
      };

      if (device || packCandidate) {
        return {
          workspaceFolder: folder.uri.fsPath,
          projectFile: fullPath,
          device: device || '',
          pack
        };
      }
    }
  }
  return null;
}

async function defaultDfpPath(vendor = DEFAULT_PACK_VENDOR) {
  const vendorRoot = path.join(os.homedir(), '.mchp_packs', vendor);
  const packNames = (await listDirSafe(vendorRoot)).sort((a, b) => a.localeCompare(b));
  let bestMatch = null;

  for (const packName of packNames) {
    if (!packName.toUpperCase().endsWith('_DFP')) {
      continue;
    }

    const packRoot = path.join(vendorRoot, packName);
    if (!(await isDirectory(packRoot))) {
      continue;
    }

    const versions = await listDirSafe(packRoot);
    for (const version of versions) {
      const versionRoot = path.join(packRoot, version);
      if (!(await isDirectory(versionRoot))) {
        continue;
      }

      if (
        !bestMatch ||
        compareVersionLabels(version, bestMatch.version) > 0 ||
        (compareVersionLabels(version, bestMatch.version) === 0 &&
          packName.localeCompare(bestMatch.packName) < 0)
      ) {
        bestMatch = { packName, version, root: versionRoot };
      }
    }
  }

  return bestMatch ? bestMatch.root : '';
}

async function resolvePackRoot(configuredPath, detected) {
  if (configuredPath) {
    return configuredPath;
  }
  if (detected && detected.pack && detected.pack.name && detected.pack.version) {
    return path.join(
      os.homedir(),
      '.mchp_packs',
      detected.pack.vendor,
      detected.pack.name,
      detected.pack.version
    );
  }
  return defaultDfpPath();
}

async function detectDeviceFromPack(packRoot) {
  if (!packRoot) {
    return '';
  }
  const atdfDir = path.join(packRoot, 'atdf');
  const names = sortBySpecificity(
    (await listDirSafe(atdfDir)).filter((name) => /\.atdf$/i.test(name))
  );
  if (names.length < 1) {
    return '';
  }
  return names[0].replace(/\.atdf$/i, '');
}

async function parseDevLibName(packRoot, deviceLowerName) {
  if (!packRoot || !deviceLowerName) {
    return null;
  }
  const specPaths = [
    path.join(
      packRoot,
      'gcc',
      'dev',
      deviceLowerName,
      'device-specs',
      `specs-${deviceLowerName}`
    ),
    path.join(packRoot, 'xc8', 'avr', 'device-specs', `specs-${deviceLowerName}`)
  ];

  for (const specPath of specPaths) {
    const text = await readTextIfExists(specPath);
    if (!text) {
      continue;
    }
    const match = /__AVR_DEV_LIB_NAME__=([A-Za-z0-9_]+)/.exec(text);
    if (match) {
      return match[1];
    }
  }

  return null;
}

async function resolveHeaderPath(packRoot, devLibName, token) {
  if (!packRoot) {
    return null;
  }
  const includeDirs = [
    path.join(packRoot, 'xc8', 'avr', 'include', 'avr'),
    path.join(packRoot, 'include', 'avr')
  ];

  if (devLibName) {
    for (const includeDir of includeDirs) {
      const candidate = path.join(includeDir, `io${devLibName}.h`);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  for (const includeDir of includeDirs) {
    const names = await listDirSafe(includeDir);
    const candidates = sortBySpecificity(
      names.filter(
        (name) =>
          /^io.*\.h$/i.test(name) &&
          (!token || name.toLowerCase().includes(token.toLowerCase()))
      )
    );
    if (candidates.length > 0) {
      return path.join(includeDir, candidates[0]);
    }
  }

  return null;
}

async function resolveIncPath(packRoot, devLibName, token) {
  if (!packRoot) {
    return null;
  }
  const incDir = path.join(packRoot, 'avrasm', 'inc');
  if (devLibName) {
    const candidate = path.join(incDir, `${devLibName}def.inc`);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  const names = await listDirSafe(incDir);
  const candidates = sortBySpecificity(
    names.filter(
      (name) =>
        /def\.inc$/i.test(name) &&
        (!token || name.toLowerCase().includes(token.toLowerCase()))
    )
  );
  if (candidates.length > 0) {
    return path.join(incDir, candidates[0]);
  }
  return null;
}

async function resolveAtdfPath(packRoot, deviceName, deviceLowerName, token) {
  if (!packRoot) {
    return null;
  }
  const atdfDir = path.join(packRoot, 'atdf');
  if (deviceName) {
    const directCandidate = path.join(atdfDir, `${deviceName}.atdf`);
    if (await fileExists(directCandidate)) {
      return directCandidate;
    }
  }

  const names = await listDirSafe(atdfDir);
  if (deviceLowerName) {
    const lowerExact = `${deviceLowerName}.atdf`;
    const exact = names.find((name) => name.toLowerCase() === lowerExact);
    if (exact) {
      return path.join(atdfDir, exact);
    }
  }

  const tokenCandidates = sortBySpecificity(
    names.filter(
      (name) =>
        /\.atdf$/i.test(name) &&
        (!token || name.toLowerCase().includes(token.toLowerCase()))
    )
  );
  if (tokenCandidates.length > 0) {
    return path.join(atdfDir, tokenCandidates[0]);
  }

  return null;
}

async function resolveIndexFiles() {
  const configuredPath = getConfiguredDfpPath();
  const configuredDevice = getConfiguredDevice();
  const detected = shouldAutoDetectMplabProject()
    ? await detectMplabTarget()
    : null;

  const packRoot = await resolvePackRoot(configuredPath, detected);
  let device = configuredDevice || (detected && detected.device) || '';
  if (!device) {
    device = await detectDeviceFromPack(packRoot);
  }
  const deviceLowerName = normalizeDeviceForLookup(device);
  const token = deviceLowerName ? extractDeviceToken(deviceLowerName) : '';
  const devLibName = await parseDevLibName(packRoot, deviceLowerName);

  const files = [];
  const headerPath = await resolveHeaderPath(packRoot, devLibName, token);
  if (headerPath) {
    files.push({ kind: 'header', filePath: headerPath });
  }
  const incPath = await resolveIncPath(packRoot, devLibName, token);
  if (incPath) {
    files.push({ kind: 'inc', filePath: incPath });
  }
  const atdfPath = await resolveAtdfPath(packRoot, device, deviceLowerName, token);
  if (atdfPath) {
    files.push({ kind: 'atdf', filePath: atdfPath });
  }

  return {
    packRoot,
    device,
    deviceLowerName,
    devLibName,
    files,
    detectedProjectFile: detected ? detected.projectFile : null
  };
}

function safeMarkdown(text) {
  return text.replace(/[`*_{}[\]()#+\-!]/g, '\\$&');
}

function trimLine(text, max = 120) {
  const squashed = text.trim().replace(/\s+/g, ' ');
  if (squashed.length <= max) {
    return squashed;
  }
  return `${squashed.slice(0, max - 3)}...`;
}

function clampConfigNumber(key, defaultValue, minValue = 1, maxValue = 10000) {
  const configured = Number(getConfig().get(key, defaultValue));
  if (!Number.isFinite(configured)) {
    return defaultValue;
  }
  if (configured < minValue) {
    return minValue;
  }
  if (configured > maxValue) {
    return maxValue;
  }
  return Math.trunc(configured);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeSymbolRange(line, column, symbol) {
  const safeColumn = Math.max(0, column);
  return new vscode.Range(
    new vscode.Position(line, safeColumn),
    new vscode.Position(line, safeColumn + symbol.length)
  );
}

function localKindToSymbolKind(kind) {
  if (kind === 'label') {
    return vscode.SymbolKind.Function;
  }
  if (kind === 'equ' || kind === 'set') {
    return vscode.SymbolKind.Constant;
  }
  return vscode.SymbolKind.Variable;
}

function extractSymbolAtPosition(document, position) {
  const range = document.getWordRangeAtPosition(position, WORD_REGEX);
  if (!range) {
    return null;
  }
  const symbol = document.getText(range);
  if (!symbol) {
    return null;
  }
  return symbol;
}

function addSymbol(map, symbolList, symbol, entry) {
  if (!symbol) {
    return;
  }
  let entries = map.get(symbol);
  if (!entries) {
    entries = [];
    map.set(symbol, entries);
    symbolList.push(symbol);
  }
  if (entries.length < 20) {
    entries.push(entry);
  }
}

function parseSymbolsFromLine(line, kind) {
  const found = [];
  let match = null;

  match = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\b(.*)$/.exec(line);
  if (match) {
    found.push({
      symbol: match[1],
      detail: trimLine(match[0]),
      kind: 'macro'
    });
  }

  match = /^\s*\.equ\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*=\s*(.+)$/.exec(line);
  if (match) {
    found.push({
      symbol: match[1],
      detail: trimLine(match[0]),
      kind: 'equ'
    });
  }

  match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(([^)]*)\)\s*,?/.exec(line);
  if (match) {
    found.push({
      symbol: match[1],
      detail: trimLine(match[0]),
      kind: 'enum'
    });
  }

  if (kind === 'atdf') {
    // ATDF is verbose; keep only uppercase-ish names to reduce noise.
    match = /\bname="([A-Za-z_][A-Za-z0-9_]*)"/.exec(line);
    if (match) {
      const candidate = match[1];
      if (
        /[A-Z]/.test(candidate) &&
        (candidate.includes('_') || candidate === candidate.toUpperCase())
      ) {
        found.push({
          symbol: candidate,
          detail: trimLine(match[0]),
          kind: 'atdf'
        });
      }
    }
  }

  return found;
}

async function buildDfpIndex() {
  const target = await resolveIndexFiles();
  const root = target.packRoot;
  const symbols = new Map();
  const symbolList = [];
  const scannedFiles = [];

  for (const spec of target.files) {
    const filePath = spec.filePath;
    const text = await readTextIfExists(filePath);
    if (!text) {
      continue;
    }

    scannedFiles.push(filePath);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const parsed = parseSymbolsFromLine(line, spec.kind);
      for (const item of parsed) {
        addSymbol(symbols, symbolList, item.symbol, {
          file: filePath,
          line: i + 1,
          text: line,
          kind: item.kind
        });
      }
    }
  }

  symbolList.sort((a, b) => a.localeCompare(b));

  return {
    root,
    device: target.device,
    devLibName: target.devLibName,
    detectedProjectFile: target.detectedProjectFile,
    symbols,
    symbolList,
    scannedFiles,
    builtAt: new Date()
  };
}

async function getDfpIndex(force = false) {
  if (force) {
    cachedIndex = null;
    indexBuildPromise = null;
  }

  if (cachedIndex) {
    return cachedIndex;
  }

  if (indexBuildPromise) {
    return indexBuildPromise;
  }

  indexBuildPromise = buildDfpIndex()
    .then((index) => {
      cachedIndex = index;
      return index;
    })
    .finally(() => {
      indexBuildPromise = null;
    });

  return indexBuildPromise;
}

function parseLocalSymbolsFromLines(lines) {
  const symbols = new Map();
  const entries = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let match = LOCAL_LABEL_REGEX.exec(line);
    if (match) {
      const symbol = match[1];
      const column = Math.max(0, line.indexOf(symbol));
      const entry = {
        symbol,
        kind: 'label',
        line: i,
        column,
        detail: trimLine(line)
      };
      symbols.set(symbol, entry);
      entries.push(entry);
      continue;
    }

    match = LOCAL_EQU_REGEX.exec(line);
    if (match) {
      const symbol = match[1];
      const column = Math.max(0, line.indexOf(symbol));
      const entry = {
        symbol,
        kind: 'equ',
        line: i,
        column,
        detail: trimLine(line)
      };
      symbols.set(symbol, entry);
      entries.push(entry);
      continue;
    }

    match = LOCAL_SET_REGEX.exec(line);
    if (match) {
      const symbol = match[1];
      const column = Math.max(0, line.indexOf(symbol));
      const entry = {
        symbol,
        kind: 'set',
        line: i,
        column,
        detail: trimLine(line)
      };
      symbols.set(symbol, entry);
      entries.push(entry);
    }
  }

  return { symbols, entries };
}

function getLocalSymbolData(document) {
  const key = document.uri.toString();
  const cached = localSymbolCache.get(key);
  if (cached && cached.version === document.version) {
    return cached;
  }

  const parsed = parseLocalSymbolsFromLines(document.getText().split(/\r?\n/));
  const value = {
    version: document.version,
    symbols: parsed.symbols,
    entries: parsed.entries
  };

  localSymbolCache.set(key, value);
  return value;
}

function getLocalSymbols(document) {
  return getLocalSymbolData(document).symbols;
}

function getLocalSymbolEntries(document) {
  return getLocalSymbolData(document).entries;
}

function makeLocation(uri, lineNumber1Based) {
  const position = new vscode.Position(Math.max(0, lineNumber1Based - 1), 0);
  return new vscode.Location(uri, position);
}

function isAssemblyFilePath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext === '.s' || ext === '.asm' || ext === '.as' || ext === '.inc';
}

function getOpenAssemblyDocumentMap() {
  const map = new Map();
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file') {
      continue;
    }
    if (!isAssemblyFilePath(document.uri.fsPath)) {
      continue;
    }
    map.set(document.uri.toString(), document);
  }
  return map;
}

async function getWorkspaceAssemblyFiles(maxFiles) {
  const uris = await vscode.workspace.findFiles(
    WORKSPACE_ASM_GLOB,
    WORKSPACE_EXCLUDE_GLOB,
    maxFiles
  );
  return uris.filter(
    (uri) => uri.scheme === 'file' && isAssemblyFilePath(uri.fsPath)
  );
}

async function getTextForUri(uri, openDocumentMap) {
  const openDocument = openDocumentMap.get(uri.toString());
  if (openDocument) {
    return openDocument.getText();
  }

  const text = await readTextIfExists(uri.fsPath);
  return text || '';
}

function findSymbolMatchesInText(text, symbol) {
  if (!text || !symbol) {
    return [];
  }

  const escaped = escapeRegex(symbol);
  const boundary = `[^${IDENTIFIER_CHAR_CLASS}]`;
  const regex = new RegExp(`(^|${boundary})(${escaped})(?![${IDENTIFIER_CHAR_CLASS}])`, 'g');
  const matches = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    regex.lastIndex = 0;

    let match = null;
    while ((match = regex.exec(lineText)) !== null) {
      const leadingLength = match[1] ? match[1].length : 0;
      const column = match.index + leadingLength;
      matches.push({
        line: i,
        column,
        lineText
      });
    }
  }

  return matches;
}

function isDefinitionOccurrence(lineText, symbol, column) {
  const checks = [LOCAL_LABEL_REGEX, LOCAL_EQU_REGEX, LOCAL_SET_REGEX];
  for (const regex of checks) {
    const match = regex.exec(lineText);
    if (!match || match[1] !== symbol) {
      continue;
    }
    const symbolColumn = lineText.indexOf(match[1]);
    if (symbolColumn === column) {
      return true;
    }
  }
  return false;
}

async function provideDocumentSymbols(document) {
  const entries = getLocalSymbolEntries(document);
  if (!entries.length) {
    return [];
  }

  return entries.map((entry) => {
    const lineRange = document.lineAt(entry.line).range;
    const selectionRange = makeSymbolRange(entry.line, entry.column, entry.symbol);
    return new vscode.DocumentSymbol(
      entry.symbol,
      `${entry.kind} (line ${entry.line + 1})`,
      localKindToSymbolKind(entry.kind),
      lineRange,
      selectionRange
    );
  });
}

async function provideWorkspaceSymbols(query) {
  const normalized = (query || '').trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const maxFiles = clampConfigNumber(
    'maxWorkspaceScanFiles',
    DEFAULT_MAX_WORKSPACE_SCAN_FILES,
    20,
    10000
  );
  const maxSymbols = clampConfigNumber(
    'maxWorkspaceSymbols',
    DEFAULT_MAX_WORKSPACE_SYMBOLS,
    20,
    20000
  );

  const openDocs = getOpenAssemblyDocumentMap();
  const files = await getWorkspaceAssemblyFiles(maxFiles);
  const uriMap = new Map();

  for (const uri of files) {
    uriMap.set(uri.toString(), uri);
  }
  for (const document of openDocs.values()) {
    uriMap.set(document.uri.toString(), document.uri);
  }

  const results = [];
  const seen = new Set();
  const addSymbol = (symbolInfo, dedupeKey) => {
    if (seen.has(dedupeKey)) {
      return false;
    }
    seen.add(dedupeKey);
    results.push(symbolInfo);
    return results.length >= maxSymbols;
  };

  for (const uri of uriMap.values()) {
    const text = await getTextForUri(uri, openDocs);
    if (!text) {
      continue;
    }

    const parsed = parseLocalSymbolsFromLines(text.split(/\r?\n/));
    for (const entry of parsed.entries) {
      if (!entry.symbol.toLowerCase().includes(normalized)) {
        continue;
      }

      const location = new vscode.Location(
        uri,
        makeSymbolRange(entry.line, entry.column, entry.symbol)
      );

      const symbolInfo = new vscode.SymbolInformation(
        entry.symbol,
        localKindToSymbolKind(entry.kind),
        `${entry.kind} local symbol`,
        location
      );

      const dedupeKey = `${uri.toString()}:${entry.line}:${entry.column}:${entry.symbol}`;
      if (addSymbol(symbolInfo, dedupeKey)) {
        return results;
      }
    }
  }

  if (getConfig().get('includeDfpInWorkspaceSymbols', true)) {
    const index = await getDfpIndex();
    for (const symbol of index.symbolList) {
      if (!symbol.toLowerCase().includes(normalized)) {
        continue;
      }
      const first = (index.symbols.get(symbol) || [])[0];
      if (!first) {
        continue;
      }

      const uri = vscode.Uri.file(first.file);
      const column = Math.max(0, (first.text || '').indexOf(symbol));
      const location = new vscode.Location(
        uri,
        makeSymbolRange(Math.max(0, first.line - 1), column, symbol)
      );
      const symbolInfo = new vscode.SymbolInformation(
        symbol,
        vscode.SymbolKind.Constant,
        `${first.kind} (${index.device || 'AVR'} pack)`,
        location
      );

      const dedupeKey = `dfp:${first.file}:${first.line}:${symbol}`;
      if (addSymbol(symbolInfo, dedupeKey)) {
        break;
      }
    }
  }

  return results;
}

async function provideReferences(document, position, context) {
  if (!getConfig().get('enableReferences', true)) {
    return [];
  }

  const symbol = extractSymbolAtPosition(document, position);
  if (!symbol) {
    return [];
  }

  const includeDeclaration = Boolean(context && context.includeDeclaration);
  const maxFiles = clampConfigNumber(
    'maxWorkspaceScanFiles',
    DEFAULT_MAX_WORKSPACE_SCAN_FILES,
    20,
    10000
  );
  const maxReferences = clampConfigNumber(
    'maxReferenceResults',
    DEFAULT_MAX_REFERENCE_RESULTS,
    20,
    20000
  );

  const openDocs = getOpenAssemblyDocumentMap();
  const files = await getWorkspaceAssemblyFiles(maxFiles);
  const uriMap = new Map();

  for (const uri of files) {
    uriMap.set(uri.toString(), uri);
  }
  for (const openDoc of openDocs.values()) {
    uriMap.set(openDoc.uri.toString(), openDoc.uri);
  }
  if (document.uri.scheme === 'file' && isAssemblyFilePath(document.uri.fsPath)) {
    uriMap.set(document.uri.toString(), document.uri);
  }

  const locations = [];
  const seen = new Set();
  const addLocation = (uri, line, column) => {
    const key = `${uri.toString()}:${line}:${column}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    locations.push(new vscode.Location(uri, makeSymbolRange(line, column, symbol)));
    return locations.length >= maxReferences;
  };

  for (const uri of uriMap.values()) {
    const text = await getTextForUri(uri, openDocs);
    if (!text) {
      continue;
    }

    const matches = findSymbolMatchesInText(text, symbol);
    for (const match of matches) {
      if (
        !includeDeclaration &&
        isDefinitionOccurrence(match.lineText, symbol, match.column)
      ) {
        continue;
      }
      if (addLocation(uri, match.line, match.column)) {
        return locations;
      }
    }
  }

  if (includeDeclaration) {
    const index = await getDfpIndex();
    const hits = index.symbols.get(symbol) || [];
    for (const hit of hits) {
      const column = Math.max(0, (hit.text || '').indexOf(symbol));
      if (
        addLocation(vscode.Uri.file(hit.file), Math.max(0, hit.line - 1), column)
      ) {
        break;
      }
    }
  }

  return locations;
}

async function provideHover(document, position) {
  const symbol = extractSymbolAtPosition(document, position);
  if (!symbol) {
    return null;
  }

  const localSymbols = getLocalSymbols(document);
  const local = localSymbols.get(symbol);

  const index = await getDfpIndex();
  const hits = index.symbols.get(symbol) || [];

  if (!local && hits.length === 0) {
    return null;
  }

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${safeMarkdown(symbol)}**`);

  if (local) {
    md.appendMarkdown(
      `\n\nLocal ${local.kind} in this file at line ${local.line + 1}.`
    );
    md.appendCodeblock(local.detail, 'asm');
  }

  if (hits.length > 0) {
    const max = Number(getConfig().get('maxHoverResults', 6));
    md.appendMarkdown(`\n\n${safeMarkdown(index.device || 'AVR')} pack matches:`);
    for (const hit of hits.slice(0, max)) {
      const relPath = path.relative(index.root, hit.file) || hit.file;
      md.appendMarkdown(
        `\n- \`${safeMarkdown(relPath)}:${hit.line}\` (${hit.kind})`
      );
      md.appendCodeblock(trimLine(hit.text), 'c');
    }
    if (hits.length > max) {
      md.appendMarkdown(`\n... ${hits.length - max} more match(es).`);
    }
  }

  return new vscode.Hover(md);
}

async function provideDefinition(document, position) {
  const symbol = extractSymbolAtPosition(document, position);
  if (!symbol) {
    return null;
  }

  const locations = [];
  const local = getLocalSymbols(document).get(symbol);
  if (local) {
    locations.push(
      new vscode.Location(document.uri, new vscode.Position(local.line, 0))
    );
  }

  const index = await getDfpIndex();
  const hits = index.symbols.get(symbol) || [];
  for (const hit of hits.slice(0, 20)) {
    locations.push(makeLocation(vscode.Uri.file(hit.file), hit.line));
  }

  if (locations.length === 0) {
    return null;
  }
  if (locations.length === 1) {
    return locations[0];
  }
  return locations;
}

async function provideCompletionItems(document, position) {
  if (!getConfig().get('enableCompletion', true)) {
    return [];
  }

  const wordRange = document.getWordRangeAtPosition(position, WORD_REGEX);
  const prefix = wordRange ? document.getText(wordRange) : '';
  const maxItems = Number(getConfig().get('maxCompletionItems', 200));
  const results = [];
  const seen = new Set();

  const localSymbols = getLocalSymbols(document);
  for (const [symbol, info] of localSymbols.entries()) {
    if (prefix && !symbol.startsWith(prefix)) {
      continue;
    }
    const item = new vscode.CompletionItem(
      symbol,
      vscode.CompletionItemKind.Variable
    );
    item.detail = `local ${info.kind} (line ${info.line + 1})`;
    item.sortText = `0_${symbol}`;
    results.push(item);
    seen.add(symbol);
    if (results.length >= maxItems) {
      return results;
    }
  }

  const index = await getDfpIndex();
  for (const symbol of index.symbolList) {
    if (seen.has(symbol)) {
      continue;
    }
    if (prefix && !symbol.startsWith(prefix)) {
      continue;
    }
    const first = (index.symbols.get(symbol) || [])[0];
    const item = new vscode.CompletionItem(
      symbol,
      vscode.CompletionItemKind.Constant
    );
    if (first) {
      const relPath = path.relative(index.root, first.file) || first.file;
      item.detail = `${first.kind} from ${relPath}:${first.line}`;
    }
    item.sortText = `1_${symbol}`;
    results.push(item);
    if (results.length >= maxItems) {
      break;
    }
  }

  return results;
}

function getSelectionOrWord(editor) {
  if (!editor) {
    return '';
  }
  const selected = editor.document.getText(editor.selection).trim();
  if (selected) {
    return selected;
  }
  return extractSymbolAtPosition(editor.document, editor.selection.active) || '';
}

async function runLookupCommand() {
  const editor = vscode.window.activeTextEditor;
  const seed = getSelectionOrWord(editor);

  const symbol =
    seed ||
    (await vscode.window.showInputBox({
      prompt: 'Enter AVR symbol to lookup',
      placeHolder: 'Example: RTC_PITCTRLA',
      ignoreFocusOut: true
    }));

  if (!symbol) {
    return;
  }

  const picks = [];
  if (editor) {
    const local = getLocalSymbols(editor.document).get(symbol);
    if (local) {
      picks.push({
        label: `Local ${local.kind}: ${symbol}`,
        description: `line ${local.line + 1}`,
        detail: local.detail,
        location: new vscode.Location(
          editor.document.uri,
          new vscode.Position(local.line, 0)
        )
      });
    }
  }

  const index = await getDfpIndex();
  const hits = index.symbols.get(symbol) || [];
  for (const hit of hits.slice(0, 50)) {
    const relPath = path.relative(index.root, hit.file) || hit.file;
    picks.push({
      label: `${symbol} (${hit.kind})`,
      description: `${relPath}:${hit.line}`,
      detail: trimLine(hit.text),
      location: makeLocation(vscode.Uri.file(hit.file), hit.line)
    });
  }

  if (picks.length === 0) {
    vscode.window.showInformationMessage(
      `No symbol matches found for "${symbol}" in ${index.device || 'current AVR target'}.`
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: `Matches for ${symbol}`,
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!selected || !selected.location) {
    return;
  }

  const doc = await vscode.workspace.openTextDocument(selected.location.uri);
  await vscode.window.showTextDocument(doc, {
    preview: false,
    selection: selected.location.range
  });
}

async function rebuildIndexCommand() {
  const index = await getDfpIndex(true);
  if (!index.scannedFiles.length) {
    vscode.window.showWarningMessage(
      `AVR ASM Hints: no DFP symbol files found for ${index.device || 'target'} at "${index.root}".`
    );
    return;
  }
  vscode.window.showInformationMessage(
    `AVR ASM Hints index rebuilt for ${index.device || 'target'} (${index.symbolList.length} symbols).`
  );
}

function registerProviders(context) {
  const selector = [
    { scheme: 'file', language: 'avr-asm' },
    { scheme: 'file', language: 'nasm' },
    { scheme: 'file', language: 'asm' },
    { scheme: 'file', language: 'assembly' },
    { scheme: 'file', language: 'gas' }
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      provideHover
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems
      },
      '_',
      '.'
    )
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences
    })
  );

  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols
    })
  );
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('avrAsmHints.lookupSymbol', runLookupCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('avrAsmHints.rebuildIndex', rebuildIndexCommand)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('avrAsmHints')) {
        cachedIndex = null;
        indexBuildPromise = null;
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      localSymbolCache.delete(document.uri.toString());
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.fileName.endsWith('.mplab.json')) {
        cachedIndex = null;
        indexBuildPromise = null;
      }
    })
  );

  registerProviders(context);

  // Warm the index in background so first hover is quick.
  getDfpIndex().catch(() => {
    // Ignore errors; user can run rebuild command after fixing dfpPath.
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
