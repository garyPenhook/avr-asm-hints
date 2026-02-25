'use strict';

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const WORD_REGEX = /[A-Za-z_.$][A-Za-z0-9_.$]*/;
const LOCAL_LABEL_REGEX = /^\s*([A-Za-z_.$][A-Za-z0-9_.$]*)\s*:/;
const LOCAL_EQU_REGEX = /^\s*\.equ\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*(?:=|,)\s*(.+)$/i;
const LOCAL_SET_REGEX = /^\s*\.set\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*(?:=|,)\s*(.+)$/i;
const IDENTIFIER_CHAR_CLASS = 'A-Za-z0-9_.$';
const WORKSPACE_ASM_GLOB = '**/*.{S,s,asm,ASM,as,AS,inc,INC}';
const WORKSPACE_EXCLUDE_GLOB = '**/{_build,out,cmake,node_modules,.git}/**';

const DEFAULT_MAX_WORKSPACE_SCAN_FILES = 400;
const DEFAULT_MAX_WORKSPACE_SYMBOLS = 300;
const DEFAULT_MAX_REFERENCE_RESULTS = 500;
const DEFAULT_MAX_DEVICE_INFERENCE_FILES = 60;
const INDEX_SCOPE_GLOBAL = '__global__';
const OUTPUT_CHANNEL_NAME = 'AVR ASM Navigator';
const SUPPORTED_LANGUAGE_IDS = new Set([
  'avr-asm',
  'nasm',
  'asm',
  'assembly',
  'gas'
]);

const DEFAULT_PACK_VENDOR = 'Microchip';
const AVR_INSTRUCTION_MNEMONICS = Object.freeze([
  'adc',
  'add',
  'adiw',
  'and',
  'andi',
  'asr',
  'bclr',
  'bld',
  'brbc',
  'brbs',
  'brcc',
  'brcs',
  'break',
  'breq',
  'brge',
  'brhc',
  'brhs',
  'brid',
  'brie',
  'brlo',
  'brlt',
  'brmi',
  'brne',
  'brpl',
  'brsh',
  'brtc',
  'brts',
  'brvc',
  'brvs',
  'bset',
  'bst',
  'call',
  'cbi',
  'cbr',
  'clc',
  'clh',
  'cli',
  'cln',
  'clr',
  'cls',
  'clt',
  'clv',
  'clz',
  'com',
  'cp',
  'cpc',
  'cpi',
  'cpse',
  'dec',
  'des',
  'eicall',
  'eijmp',
  'elpm',
  'eor',
  'fmul',
  'fmuls',
  'fmulsu',
  'icall',
  'ijmp',
  'in',
  'inc',
  'jmp',
  'lac',
  'las',
  'lat',
  'ld',
  'ldd',
  'ldi',
  'lds',
  'lpm',
  'lsl',
  'lsr',
  'mov',
  'movw',
  'mul',
  'muls',
  'mulsu',
  'neg',
  'nop',
  'or',
  'ori',
  'out',
  'pop',
  'push',
  'rcall',
  'ret',
  'reti',
  'rjmp',
  'rol',
  'ror',
  'sbc',
  'sbci',
  'sbi',
  'sbic',
  'sbis',
  'sbiw',
  'sbr',
  'sbrc',
  'sbrs',
  'sec',
  'seh',
  'sei',
  'sen',
  'ser',
  'ses',
  'set',
  'sev',
  'sez',
  'sleep',
  'spm',
  'st',
  'std',
  'sts',
  'sub',
  'subi',
  'swap',
  'tst',
  'wdr',
  'xch'
]);
const AVR_NO_OPERAND_INSTRUCTIONS = new Set([
  'break',
  'clc',
  'clh',
  'cli',
  'cln',
  'cls',
  'clt',
  'clv',
  'clz',
  'eicall',
  'eijmp',
  'icall',
  'ijmp',
  'nop',
  'ret',
  'reti',
  'sec',
  'seh',
  'sei',
  'sen',
  'ses',
  'set',
  'sev',
  'sez',
  'sleep',
  'spm',
  'wdr'
]);
const AVR_REGISTER_NAMES = Object.freeze([
  ...Array.from({ length: 32 }, (_, index) => `r${index}`),
  'x',
  'y',
  'z',
  'xl',
  'xh',
  'yl',
  'yh',
  'zl',
  'zh'
]);

const cachedIndexByScope = new Map();
const indexBuildPromiseByScope = new Map();
const localSymbolCache = new Map();
let outputChannel = null;

function getConfig() {
  return vscode.workspace.getConfiguration('avrAsmNavigator');
}

function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel;
}

function logOutput(level, message) {
  const channel = getOutputChannel();
  channel.appendLine(
    `[${new Date().toISOString()}] [${level}] ${String(message || '')}`
  );
}

function logInfo(message) {
  logOutput('info', message);
}

function logWarn(message) {
  logOutput('warn', message);
}

function logError(message, error = null) {
  if (error && error.message) {
    logOutput('error', `${message}: ${error.message}`);
    return;
  }
  logOutput('error', message);
}

function isCancelled(token) {
  return Boolean(token && token.isCancellationRequested);
}

function scopeLabel(scope) {
  if (!scope) {
    return INDEX_SCOPE_GLOBAL;
  }
  if (scope.workspaceFolder) {
    return scope.workspaceFolder.name || scope.workspaceFolder.uri.toString();
  }
  return scope.key || INDEX_SCOPE_GLOBAL;
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

async function listDirUriSafe(directoryUri) {
  try {
    return (await vscode.workspace.fs.readDirectory(directoryUri)).map(
      ([name]) => name
    );
  } catch {
    return [];
  }
}

async function readTextUriIfExists(uri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

function getUriExtension(uri) {
  if (!uri) {
    return '';
  }
  return path.extname(uri.path || uri.fsPath || '').toLowerCase();
}

function isAssemblyFilePath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext === '.s' || ext === '.asm' || ext === '.as' || ext === '.inc';
}

function isAssemblyUri(uri) {
  return isAssemblyFilePath(uri ? uri.path : '');
}

function isAssemblyDocument(document) {
  if (!document) {
    return false;
  }
  return (
    SUPPORTED_LANGUAGE_IDS.has(document.languageId) || isAssemblyUri(document.uri)
  );
}

function isMplabProjectUri(uri) {
  return Boolean(uri && uri.path && uri.path.toLowerCase().endsWith('.mplab.json'));
}

function getIndexScopeForUri(uri) {
  const workspaceFolder = uri ? vscode.workspace.getWorkspaceFolder(uri) : null;
  if (workspaceFolder) {
    return {
      key: `folder:${workspaceFolder.uri.toString()}`,
      workspaceFolder
    };
  }
  return {
    key: INDEX_SCOPE_GLOBAL,
    workspaceFolder: null
  };
}

function getIndexScopeForDocument(document) {
  return getIndexScopeForUri(document ? document.uri : null);
}

function getDefaultIndexScope() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document) {
    return getIndexScopeForDocument(editor.document);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length > 0) {
    const first = workspaceFolders[0];
    return {
      key: `folder:${first.uri.toString()}`,
      workspaceFolder: first
    };
  }

  return {
    key: INDEX_SCOPE_GLOBAL,
    workspaceFolder: null
  };
}

function getAllWorkspaceIndexScopes() {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length === 0) {
    return [getDefaultIndexScope()];
  }
  return workspaceFolders.map((workspaceFolder) => ({
    key: `folder:${workspaceFolder.uri.toString()}`,
    workspaceFolder
  }));
}

function clearIndexCache(scope = null) {
  if (!scope) {
    cachedIndexByScope.clear();
    indexBuildPromiseByScope.clear();
    return;
  }
  cachedIndexByScope.delete(scope.key);
  indexBuildPromiseByScope.delete(scope.key);
}

function maybeInvalidateIndexForUri(uri) {
  if (!uri) {
    return;
  }
  if (isMplabProjectUri(uri) || isAssemblyUri(uri)) {
    clearIndexCache(getIndexScopeForUri(uri));
  }
}

function getConfiguredDfpPath() {
  return (getConfig().get('dfpPath', '') || '').trim();
}

function getConfiguredDevice() {
  return (getConfig().get('device', '') || '').trim();
}

function normalizeGuessedDeviceName(rawDeviceName) {
  const raw = String(rawDeviceName || '').trim();
  if (!raw) {
    return '';
  }

  const at90Short = /^90([0-9a-z]+)$/i.exec(raw);
  if (at90Short) {
    return `AT90${at90Short[1].toUpperCase()}`;
  }

  const tinyInc = /^tn([0-9][0-9a-z]*)$/i.exec(raw);
  if (tinyInc) {
    return `ATtiny${tinyInc[1].toUpperCase()}`;
  }

  const megaInc = /^m([0-9][0-9a-z]*)$/i.exec(raw);
  if (megaInc) {
    return `ATmega${megaInc[1].toUpperCase()}`;
  }

  const tiny = /^attiny([0-9][0-9a-z]*)$/i.exec(raw);
  if (tiny) {
    return `ATtiny${tiny[1].toUpperCase()}`;
  }

  const mega = /^atmega([0-9][0-9a-z]*)$/i.exec(raw);
  if (mega) {
    return `ATmega${mega[1].toUpperCase()}`;
  }

  const xmega = /^atxmega([0-9][0-9a-z]*)$/i.exec(raw);
  if (xmega) {
    return `ATxmega${xmega[1].toUpperCase()}`;
  }

  const tinyShort = /^tiny([0-9][0-9a-z]*)$/i.exec(raw);
  if (tinyShort) {
    return `ATtiny${tinyShort[1].toUpperCase()}`;
  }

  const megaShort = /^mega([0-9][0-9a-z]*)$/i.exec(raw);
  if (megaShort) {
    return `ATmega${megaShort[1].toUpperCase()}`;
  }

  const xmegaShort = /^xmega([0-9][0-9a-z]*)$/i.exec(raw);
  if (xmegaShort) {
    return `ATxmega${xmegaShort[1].toUpperCase()}`;
  }

  const avr = /^avr([0-9][0-9a-z]*)$/i.exec(raw);
  if (avr) {
    return `AVR${avr[1].toUpperCase()}`;
  }

  const at90 = /^at90([0-9a-z]+)$/i.exec(raw);
  if (at90) {
    return `AT90${at90[1].toUpperCase()}`;
  }

  const anyAtDevice = /^at([0-9a-z]+)$/i.exec(raw);
  if (anyAtDevice) {
    return `AT${anyAtDevice[1].toUpperCase()}`;
  }

  return raw;
}

function extractDeviceCandidatesFromText(text) {
  const candidates = [];
  if (!text) {
    return candidates;
  }

  let match = null;
  const directDeviceRegex =
    /\b(?:AT(?:tiny|mega|xmega)[0-9][0-9A-Za-z]*|AT90[0-9A-Za-z]+|AVR[0-9][0-9A-Za-z]*)\b/g;
  while ((match = directDeviceRegex.exec(text)) !== null) {
    candidates.push({ device: match[0], weight: 5 });
  }

  const avrMacroRegex = /\b__AVR_([A-Za-z0-9_]+)__\b/g;
  while ((match = avrMacroRegex.exec(text)) !== null) {
    const macroName = match[1].replace(/_/g, '');
    if (!/\d/.test(macroName) && !/^AT90/i.test(macroName)) {
      continue;
    }
    candidates.push({ device: macroName, weight: 8 });
  }

  // Prefer explicit device include forms when present.
  const ioIncludeRegex = /#\s*include\s*[<"]avr\/io([a-z0-9]+)\.h[>"]/gi;
  while ((match = ioIncludeRegex.exec(text)) !== null) {
    candidates.push({ device: match[1], weight: 12 });
  }

  const defIncRegex = /\.include\s+"([a-z0-9]+)def\.inc"/gi;
  while ((match = defIncRegex.exec(text)) !== null) {
    candidates.push({ device: match[1], weight: 14 });
  }

  return candidates;
}

async function inferDeviceFromWorkspaceText(scope = null) {
  const maxScanFiles = clampConfigNumber(
    'maxWorkspaceScanFiles',
    DEFAULT_MAX_WORKSPACE_SCAN_FILES,
    20,
    10000
  );
  const scanLimit = Math.max(1, Math.min(maxScanFiles, DEFAULT_MAX_DEVICE_INFERENCE_FILES));
  const workspaceFolder = scope ? scope.workspaceFolder : null;

  const files = await getWorkspaceAssemblyFiles(scanLimit, workspaceFolder);
  if (!files.length) {
    return '';
  }

  const openDocs = getOpenAssemblyDocumentMap(workspaceFolder);
  const score = new Map();

  const addScore = (deviceName, weight) => {
    const normalized = normalizeGuessedDeviceName(deviceName);
    if (!normalized) {
      return;
    }
    const current = score.get(normalized) || 0;
    score.set(normalized, current + weight);
  };

  for (const uri of files) {
    const text = await getTextForUri(uri, openDocs);
    const candidates = extractDeviceCandidatesFromText(text);
    for (const candidate of candidates) {
      addScore(candidate.device, candidate.weight);
    }
  }

  let bestDevice = '';
  let bestScore = -1;
  for (const [device, deviceScore] of score.entries()) {
    if (
      deviceScore > bestScore ||
      (deviceScore === bestScore && device.localeCompare(bestDevice) < 0)
    ) {
      bestDevice = device;
      bestScore = deviceScore;
    }
  }

  return bestScore > 0 ? bestDevice : '';
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

async function detectMplabTarget(preferredWorkspaceFolder = null) {
  const workspaceFolders = preferredWorkspaceFolder
    ? [preferredWorkspaceFolder]
    : vscode.workspace.workspaceFolders || [];
  for (const folder of workspaceFolders) {
    const vscodeDirUri = vscode.Uri.joinPath(folder.uri, '.vscode');
    const files = await listDirUriSafe(vscodeDirUri);
    const mplabFiles = files
      .filter((file) => file.endsWith('.mplab.json'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of mplabFiles) {
      const fullUri = vscode.Uri.joinPath(vscodeDirUri, file);
      const jsonText = await readTextUriIfExists(fullUri);
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

      let xc8Version = '';
      const toolchainName =
        typeof config.toolchain === 'string' ? config.toolchain.trim() : '';
      if (toolchainName) {
        const groups = Array.isArray(parsed.propertyGroups)
          ? parsed.propertyGroups
          : [];
        const toolchainGroup = groups.find(
          (group) =>
            group &&
            group.type === 'toolchain' &&
            typeof group.name === 'string' &&
            group.name === toolchainName
        );
        if (
          toolchainGroup &&
          typeof toolchainGroup.provider === 'string' &&
          toolchainGroup.provider.toLowerCase().includes('xc8@')
        ) {
          const versionMatch = /xc8@([0-9.]+)/i.exec(toolchainGroup.provider);
          if (versionMatch) {
            xc8Version = versionMatch[1];
          }
        }
      }

      if (device || packCandidate) {
        return {
          workspaceFolder: folder.uri.toString(),
          projectFile: fullUri.toString(),
          device: device || '',
          pack,
          xc8Version
        };
      }
    }
  }
  return null;
}

async function resolveCompilerIncludeDirs(detected = null) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (dirPath) => {
    if (!dirPath) {
      return;
    }
    const normalized = path.normalize(dirPath);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  if (detected && detected.xc8Version) {
    addCandidate(
      path.join('/opt/microchip/xc8', `v${detected.xc8Version}`, 'avr', 'avr', 'include', 'avr')
    );
    addCandidate(
      path.join('/opt/microchip/xc8', detected.xc8Version, 'avr', 'avr', 'include', 'avr')
    );
  }

  const xc8Root = '/opt/microchip/xc8';
  const xc8Versions = await listDirSafe(xc8Root);
  const sortedVersions = xc8Versions.sort((a, b) => compareVersionLabels(b, a));
  for (const version of sortedVersions) {
    addCandidate(path.join(xc8Root, version, 'avr', 'avr', 'include', 'avr'));
  }

  const existing = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
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

async function resolveIndexFiles(scope = null) {
  const configuredPath = getConfiguredDfpPath();
  const configuredDevice = getConfiguredDevice();
  const detected = shouldAutoDetectMplabProject()
    ? await detectMplabTarget(scope ? scope.workspaceFolder : null)
    : null;

  const packRoot = await resolvePackRoot(configuredPath, detected);
  let device = configuredDevice || (detected && detected.device) || '';
  if (!device) {
    device = await inferDeviceFromWorkspaceText(scope);
  }
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

  // Add AVR core headers so function-like macros (for example _BV(bit))
  // are available for hover/definition in assembly files.
  const compilerIncludeDirs = await resolveCompilerIncludeDirs(detected);
  const coreHeaderNames = ['common.h', 'sfr_defs.h', 'interrupt.h', 'io.h'];
  const indexedPaths = new Set(files.map((entry) => entry.filePath));
  for (const includeDir of compilerIncludeDirs) {
    for (const headerName of coreHeaderNames) {
      const candidate = path.join(includeDir, headerName);
      if (!indexedPaths.has(candidate) && (await fileExists(candidate))) {
        files.push({ kind: 'header', filePath: candidate });
        indexedPaths.add(candidate);
      }
    }
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

function startsWithIgnoreCase(value, prefix) {
  if (!prefix) {
    return true;
  }
  return String(value || '')
    .toLowerCase()
    .startsWith(String(prefix || '').toLowerCase());
}

function completionSeenKey(value) {
  return String(value || '').toLowerCase();
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

  match = /^\s*\.equ\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*(?:=|,)\s*(.+)$/i.exec(line);
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

async function buildDfpIndex(scope) {
  const target = await resolveIndexFiles(scope);
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
  logInfo(
    `Index built for ${scopeLabel(scope)}: device=${target.device || 'unknown'}, symbols=${symbolList.length}, files=${scannedFiles.length}`
  );

  return {
    scopeKey: scope.key,
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

async function getDfpIndex(scope = null, force = false) {
  const resolvedScope = scope || getDefaultIndexScope();
  const scopeKey = resolvedScope.key;

  if (force) {
    clearIndexCache(resolvedScope);
  }

  if (cachedIndexByScope.has(scopeKey)) {
    return cachedIndexByScope.get(scopeKey);
  }

  if (indexBuildPromiseByScope.has(scopeKey)) {
    return indexBuildPromiseByScope.get(scopeKey);
  }

  const buildPromise = buildDfpIndex(resolvedScope)
    .then((index) => {
      cachedIndexByScope.set(scopeKey, index);
      return index;
    })
    .catch((error) => {
      logError(`Index build failed for ${scopeLabel(resolvedScope)}`, error);
      throw error;
    })
    .finally(() => {
      indexBuildPromiseByScope.delete(scopeKey);
    });

  indexBuildPromiseByScope.set(scopeKey, buildPromise);
  return buildPromise;
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

function isUriInWorkspaceFolder(uri, workspaceFolder) {
  if (!workspaceFolder) {
    return true;
  }
  const containingFolder = vscode.workspace.getWorkspaceFolder(uri);
  return Boolean(
    containingFolder &&
      containingFolder.uri.toString() === workspaceFolder.uri.toString()
  );
}

function getOpenAssemblyDocumentMap(workspaceFolder = null) {
  const map = new Map();
  for (const document of vscode.workspace.textDocuments) {
    if (!isAssemblyDocument(document)) {
      continue;
    }
    if (!isUriInWorkspaceFolder(document.uri, workspaceFolder)) {
      continue;
    }
    map.set(document.uri.toString(), document);
  }
  return map;
}

async function getWorkspaceAssemblyFiles(maxFiles, workspaceFolder = null) {
  const includePattern = workspaceFolder
    ? new vscode.RelativePattern(workspaceFolder.uri, WORKSPACE_ASM_GLOB)
    : WORKSPACE_ASM_GLOB;
  const uris = await vscode.workspace.findFiles(
    includePattern,
    WORKSPACE_EXCLUDE_GLOB,
    maxFiles
  );
  return uris.filter((uri) => isAssemblyUri(uri));
}

async function getTextForUri(uri, openDocumentMap) {
  const openDocument = openDocumentMap.get(uri.toString());
  if (openDocument) {
    return openDocument.getText();
  }

  const text = await readTextUriIfExists(uri);
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

async function provideWorkspaceSymbols(query, token) {
  if (isCancelled(token)) {
    return [];
  }

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
    if (isCancelled(token)) {
      return results;
    }
    const text = await getTextForUri(uri, openDocs);
    if (!text) {
      continue;
    }

    const parsed = parseLocalSymbolsFromLines(text.split(/\r?\n/));
    for (const entry of parsed.entries) {
      if (isCancelled(token)) {
        return results;
      }
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
    for (const scope of getAllWorkspaceIndexScopes()) {
      if (isCancelled(token)) {
        return results;
      }
      let index = null;
      try {
        index = await getDfpIndex(scope);
      } catch {
        continue;
      }

      for (const symbol of index.symbolList) {
        if (isCancelled(token)) {
          return results;
        }
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
          `${first.kind} (${index.device || 'AVR®'} pack)`,
          location
        );

        const dedupeKey = `dfp:${first.file}:${first.line}:${symbol}`;
        if (addSymbol(symbolInfo, dedupeKey)) {
          return results;
        }
      }
    }
  }

  return results;
}

async function provideReferences(document, position, context, token) {
  if (isCancelled(token)) {
    return [];
  }

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
  if (isAssemblyDocument(document)) {
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
    if (isCancelled(token)) {
      return locations;
    }
    const text = await getTextForUri(uri, openDocs);
    if (!text) {
      continue;
    }

    const matches = findSymbolMatchesInText(text, symbol);
    for (const match of matches) {
      if (isCancelled(token)) {
        return locations;
      }
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
    if (isCancelled(token)) {
      return locations;
    }
    const scope = getIndexScopeForDocument(document);
    const index = await getDfpIndex(scope);
    const hits = index.symbols.get(symbol) || [];
    for (const hit of hits) {
      if (isCancelled(token)) {
        return locations;
      }
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

async function provideHover(document, position, token) {
  if (isCancelled(token)) {
    return null;
  }

  const symbol = extractSymbolAtPosition(document, position);
  if (!symbol) {
    return null;
  }

  const localSymbols = getLocalSymbols(document);
  const local = localSymbols.get(symbol);

  const scope = getIndexScopeForDocument(document);
  const index = await getDfpIndex(scope);
  if (isCancelled(token)) {
    return null;
  }
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
    md.appendMarkdown(`\n\n${safeMarkdown(index.device || 'AVR®')} pack matches:`);
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

async function provideDefinition(document, position, token) {
  if (isCancelled(token)) {
    return null;
  }

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

  const scope = getIndexScopeForDocument(document);
  const index = await getDfpIndex(scope);
  if (isCancelled(token)) {
    return null;
  }
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

async function provideCompletionItems(document, position, token) {
  if (isCancelled(token)) {
    return [];
  }

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
    if (isCancelled(token)) {
      return results;
    }
    if (!startsWithIgnoreCase(symbol, prefix)) {
      continue;
    }
    const item = new vscode.CompletionItem(
      symbol,
      vscode.CompletionItemKind.Variable
    );
    item.detail = `local ${info.kind} (line ${info.line + 1})`;
    item.sortText = `0_${symbol}`;
    results.push(item);
    seen.add(completionSeenKey(symbol));
    if (results.length >= maxItems) {
      return results;
    }
  }

  for (const registerName of AVR_REGISTER_NAMES) {
    if (isCancelled(token)) {
      return results;
    }
    if (seen.has(completionSeenKey(registerName))) {
      continue;
    }
    if (!startsWithIgnoreCase(registerName, prefix)) {
      continue;
    }

    const item = new vscode.CompletionItem(
      registerName,
      vscode.CompletionItemKind.Variable
    );
    item.detail = 'AVR register';
    item.sortText = `1_${registerName}`;
    results.push(item);
    seen.add(completionSeenKey(registerName));
    if (results.length >= maxItems) {
      return results;
    }
  }

  if (getConfig().get('enableInstructionCompletion', true)) {
    for (const mnemonic of AVR_INSTRUCTION_MNEMONICS) {
      if (isCancelled(token)) {
        return results;
      }
      if (seen.has(completionSeenKey(mnemonic))) {
        continue;
      }
      if (!startsWithIgnoreCase(mnemonic, prefix)) {
        continue;
      }

      const item = new vscode.CompletionItem(
        mnemonic,
        vscode.CompletionItemKind.Keyword
      );
      item.detail = 'AVR instruction';
      item.insertText = AVR_NO_OPERAND_INSTRUCTIONS.has(mnemonic)
        ? mnemonic
        : `${mnemonic} `;
      item.sortText = `2_${mnemonic}`;
      results.push(item);
      seen.add(completionSeenKey(mnemonic));
      if (results.length >= maxItems) {
        return results;
      }
    }
  }

  if (isCancelled(token)) {
    return results;
  }
  const scope = getIndexScopeForDocument(document);
  const index = await getDfpIndex(scope);
  for (const symbol of index.symbolList) {
    if (isCancelled(token)) {
      return results;
    }
    if (seen.has(completionSeenKey(symbol))) {
      continue;
    }
    if (!startsWithIgnoreCase(symbol, prefix)) {
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
    item.sortText = `3_${symbol}`;
    results.push(item);
    seen.add(completionSeenKey(symbol));
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

function formatActiveTargetSummary(index, scope) {
  const builtAtText =
    index && index.builtAt ? new Date(index.builtAt).toISOString() : 'unknown';
  const lines = [
    `Scope: ${scopeLabel(scope)}`,
    `Device: ${index.device || 'unknown'}`,
    `Pack root: ${index.root || 'unknown'}`,
    `Detected project: ${index.detectedProjectFile || 'none'}`,
    `Indexed files: ${index.scannedFiles.length}`,
    `Indexed symbols: ${index.symbolList.length}`,
    `Built at: ${builtAtText}`
  ];
  return lines.join('\n');
}

async function runLookupCommand() {
  const editor = vscode.window.activeTextEditor;
  const seed = getSelectionOrWord(editor);

  const symbol =
    seed ||
    (await vscode.window.showInputBox({
      prompt: 'Enter AVR® symbol to lookup',
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

  const scope = editor
    ? getIndexScopeForDocument(editor.document)
    : getDefaultIndexScope();
  const index = await getDfpIndex(scope);
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
      `No symbol matches found for "${symbol}" in ${index.device || 'current AVR® target'}.`
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
  const scope = getDefaultIndexScope();
  let index = null;
  try {
    index = await getDfpIndex(scope, true);
  } catch (error) {
    logError(`Rebuild index failed for ${scopeLabel(scope)}`, error);
    vscode.window.showErrorMessage(
      'AVR® ASM Navigator: failed to rebuild symbol index. See "AVR ASM Navigator" output.'
    );
    return;
  }
  if (!index.scannedFiles.length) {
    logWarn(
      `No DFP symbol files found for ${index.device || 'target'} at "${index.root}" (scope: ${scopeLabel(scope)}).`
    );
    vscode.window.showWarningMessage(
      `AVR® ASM Navigator: no DFP symbol files found for ${index.device || 'target'} at "${index.root}".`
    );
    return;
  }
  logInfo(
    `Index rebuild requested for ${scopeLabel(scope)}: device=${index.device || 'unknown'}, symbols=${index.symbolList.length}.`
  );
  vscode.window.showInformationMessage(
    `AVR® ASM Navigator index rebuilt for ${index.device || 'target'} (${index.symbolList.length} symbols).`
  );
}

async function runShowActiveTargetCommand() {
  const editor = vscode.window.activeTextEditor;
  const scope = editor
    ? getIndexScopeForDocument(editor.document)
    : getDefaultIndexScope();

  let index = null;
  try {
    index = await getDfpIndex(scope);
  } catch (error) {
    logError(`Show active target failed for ${scopeLabel(scope)}`, error);
    vscode.window.showErrorMessage(
      'AVR® ASM Navigator: failed to resolve active target. See "AVR ASM Navigator" output.'
    );
    return;
  }

  const summary = formatActiveTargetSummary(index, scope);
  const channel = getOutputChannel();
  channel.appendLine('--- Active Target ---');
  channel.appendLine(summary);
  channel.show(true);

  logInfo(
    `Active target requested for ${scopeLabel(scope)}: device=${index.device || 'unknown'}, symbols=${index.symbolList.length}.`
  );
  vscode.window.showInformationMessage(
    `AVR® ASM target: ${index.device || 'unknown'} (${index.symbolList.length} symbols).`
  );
}

function registerProviders(context) {
  const selector = [
    { language: 'avr-asm' },
    { language: 'nasm' },
    { language: 'asm' },
    { language: 'assembly' },
    { language: 'gas' }
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
      '.',
      ','
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
  context.subscriptions.push(getOutputChannel());

  context.subscriptions.push(
    vscode.commands.registerCommand('avrAsmNavigator.lookupSymbol', runLookupCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('avrAsmNavigator.rebuildIndex', rebuildIndexCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'avrAsmNavigator.showActiveTarget',
      runShowActiveTargetCommand
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('avrAsmNavigator')) {
        clearIndexCache();
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
      if (isMplabProjectUri(document.uri) || isAssemblyDocument(document)) {
        clearIndexCache(getIndexScopeForDocument(document));
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) {
        maybeInvalidateIndexForUri(uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        maybeInvalidateIndexForUri(uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        maybeInvalidateIndexForUri(file.oldUri);
        maybeInvalidateIndexForUri(file.newUri);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearIndexCache();
    })
  );

  registerProviders(context);

  // Warm the index in background so first hover is quick.
  getDfpIndex(getDefaultIndexScope()).catch(() => {
    logWarn('Background index warm-up failed. Run "AVR® ASM: Rebuild Symbol Index" after fixing configuration.');
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
