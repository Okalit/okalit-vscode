const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  getAvailableSections,
  isTopLevel,
  parseRelativeImportPath,
} = require('../completion');
const {
  createVirtualDocument,
  generatedSpanToSource,
  sourceOffsetToGenerated,
} = require('../javascript-language-service');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8'),
);

test('associates .ok files with the Okalit language', () => {
  const manifest = readJson('package.json');
  const language = manifest.contributes.languages.find(({ id }) => id === 'okalit');

  assert.ok(language);
  assert.ok(language.extensions.includes('.ok'));
  assert.ok(fs.existsSync(path.join(root, language.configuration)));
  assert.ok(fs.existsSync(path.join(root, manifest.icon)));
  assert.ok(fs.existsSync(path.join(root, language.icon.light)));
  assert.ok(fs.existsSync(path.join(root, language.icon.dark)));
});

test('declares existing TextMate grammars for Okalit and Lit attributes', () => {
  const manifest = readJson('package.json');
  const grammars = manifest.contributes.grammars;

  assert.equal(grammars[0].scopeName, 'source.okalit');
  for (const grammar of grammars) {
    assert.ok(fs.existsSync(path.join(root, grammar.path)), grammar.path);
    readJson(grammar.path);
  }
});

test('provides a launch configuration for the Extension Development Host', () => {
  const launch = readJson('.vscode/launch.json');

  const config = launch.configurations.find(({ type, request }) => (
    type === 'extensionHost' && request === 'launch'
  ));

  assert.ok(config);
  assert.ok(config.args.includes('--disable-extensions'));
  assert.ok(config.args.includes('--extensionDevelopmentPath=${workspaceFolder}'));
});

test('grammar covers the current blocks and embedded render expressions', () => {
  const grammar = readJson('syntaxes/okalit.tmLanguage.json');

  assert.ok(grammar.repository['render-section']);
  assert.ok(grammar.repository.interpolation);
  assert.ok(grammar.repository['nested-brace']);
  assert.match(grammar.repository['role-section'].begin, /component\|page\|module\|main/);
  assert.match(grammar.repository['code-section'].begin, /script\|logic/);
});

test('activates the completion provider for Oakalit documents', () => {
  const manifest = readJson('package.json');

  assert.equal(manifest.main, './extension.js');
  assert.ok(manifest.activationEvents.includes('onLanguage:okalit'));
});

test('suggests only unused top-level sections and a single role', () => {
  assert.deepEqual(getAvailableSections(''), [
    'script', 'logic', 'render', 'component', 'page', 'module', 'main',
  ]);
  assert.deepEqual(
    getAvailableSections('@main {\n  tag: "main-app"\n}\n'),
    ['script', 'logic', 'render'],
  );
  assert.equal(isTopLevel('@logic {\n  count = 0;\n'), false);
  assert.equal(isTopLevel('@logic {\n  count = 0;\n}\n'), true);
});

test('recognizes relative paths in ES module imports', () => {
  assert.deepEqual(
    parseRelativeImportPath("import routes from './modules/ro"),
    { directory: './modules/', basename: 'ro', valueStart: 20 },
  );
  assert.deepEqual(
    parseRelativeImportPath("import './"),
    { directory: './', basename: '', valueStart: 8 },
  );
  assert.equal(parseRelativeImportPath("import routes from '@okalit/core'"), null);
});

test('exposes imports and class logic as mapped JavaScript virtual code', () => {
  const source = [
    '@script {',
    "  import { signal } from '@okalit/core';",
    '}',
    '',
    '@logic {',
    '  count = signal(0);',
    '}',
  ].join('\n');
  const virtual = createVirtualDocument(source, '/workspace/counter.ok', ts);
  const importOffset = source.indexOf('signal');
  const logicOffset = source.indexOf('count');

  assert.match(virtual.code, /import \{ signal \} from '@okalit\/core'/);
  assert.match(virtual.code, /class __OakalitIntellisense extends __Oakalit \{\s*count = signal\(0\);/);
  assert.equal(virtual.code[sourceOffsetToGenerated(virtual, importOffset)], 's');

  const generatedLogicOffset = sourceOffsetToGenerated(virtual, logicOffset);
  assert.equal(virtual.code.slice(generatedLogicOffset, generatedLogicOffset + 5), 'count');
  assert.deepEqual(generatedSpanToSource(virtual, generatedLogicOffset, 5), {
    start: logicOffset,
    length: 5,
  });
  assert.equal(sourceOffsetToGenerated(virtual, source.indexOf('@logic')), null);
});

test('provides JavaScript property IntelliSense for values shared across blocks', () => {
  const fileName = `${root}/.intellisense-test.ok`;
  const source = [
    '@script {',
    "  import { get } from './completion';",
    '  const user = { name: "Ada" };',
    '}',
    '@logic {',
    '  greeting = user.na;',
    '  missing = missingValue;',
    '}',
  ].join('\n');
  const virtual = createVirtualDocument(source, fileName, ts);
  const host = {
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    }),
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    getScriptFileNames: () => [virtual.fileName],
    getScriptVersion: () => '1',
    getScriptKind: () => ts.ScriptKind.JS,
    getScriptSnapshot: (name) => {
      if (name === virtual.fileName) return ts.ScriptSnapshot.fromString(virtual.code);
      const text = ts.sys.readFile(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    fileExists: (name) => name === virtual.fileName || ts.sys.fileExists(name),
    readFile: (name) => name === virtual.fileName ? virtual.code : ts.sys.readFile(name),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  const service = ts.createLanguageService(host);
  const completionOffset = sourceOffsetToGenerated(
    virtual,
    source.indexOf('user.', source.indexOf('@logic')) + 'user.na'.length,
  );
  const completions = service.getCompletionsAtPosition(virtual.fileName, completionOffset, {});
  const importCompletionOffset = sourceOffsetToGenerated(virtual, source.indexOf('get }') + 3);
  const importCompletions = service.getCompletionsAtPosition(
    virtual.fileName,
    importCompletionOffset,
    {},
  );
  const diagnostics = service.getSemanticDiagnostics(virtual.fileName);
  const missingName = diagnostics.find(({ code }) => code === 2304);

  assert.ok(completions?.entries.some(({ name }) => name === 'name'));
  assert.ok(importCompletions?.entries.some(({ name }) => name === 'getAvailableSections'));
  assert.ok(missingName);
  assert.deepEqual(
    generatedSpanToSource(virtual, missingName.start, missingName.length),
    {
      start: source.indexOf('missingValue'),
      length: 'missingValue'.length,
    },
  );
});
