const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createVirtualDocument, generatedSpanToSource, sourceOffsetToGenerated } = require('../javascript-language-service');

function query(source) {
  const virtual = createVirtualDocument(source, path.join(__dirname, 'reactive.ok'), ts);
  const host = {
    getCompilationSettings: () => ({
      allowJs: true, checkJs: true, noEmit: true,
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    }),
    getCurrentDirectory: () => path.resolve(__dirname, '..'),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    getScriptFileNames: () => [virtual.fileName],
    getScriptVersion: () => '1',
    getScriptKind: () => ts.ScriptKind.JS,
    getScriptSnapshot(name) {
      const text = name === virtual.fileName ? virtual.code : ts.sys.readFile(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    fileExists: name => name === virtual.fileName || ts.sys.fileExists(name),
    readFile: name => name === virtual.fileName ? virtual.code : ts.sys.readFile(name),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host);
  return {
    virtual,
    service,
    diagnostics: () => [
      ...service.getSyntacticDiagnostics(virtual.fileName),
      ...service.getSemanticDiagnostics(virtual.fileName),
    ].filter(item => item.start !== undefined && generatedSpanToSource(virtual, item.start, item.length || 0)),
    complete(text) {
      const position = sourceOffsetToGenerated(virtual, source.indexOf(text) + text.length);
      return service.getCompletionsAtPosition(virtual.fileName, position, {})?.entries || [];
    },
  };
}

for (const role of ['component', 'page', 'module', 'main']) {
  for (const legacy of [false, true]) {
    test(`${role} ${legacy ? 'legacy array' : 'object'} props expose reactive values and retain type errors`, () => {
      const definition = `components: { type: Array, value: [] },
        count: { type: Number, value: 0 },
        title: { type: String, value: '' },
        enabled: { type: Boolean, value: false },
        'user-name': { type: String, value: '' }`;
      const source = `@${role} {
  tag: 'example-test',
  props: ${legacy ? `[{${definition}}]` : `{${definition}}`}
}
@logic {
  setComponents(components) {
    this.components.value = components;
    this.components = [];
    this.components.set([]);
    this.components.get().push({});
    this.count.value++;
    this.title.value.toUpperCase();
    this.enabled.value = true;
    this['user-name'].value = 'Ada';
    this.title.set(123);
    this.notDeclared.value = true;
  }
}
`;
      const result = query(source);
      try {
        const diagnostics = result.diagnostics();
        assert.equal(diagnostics.length, 2, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
        assert.ok(diagnostics.some(d => d.code === 2345));
        assert.ok(diagnostics.some(d => [2339, 2551].includes(d.code)));
        const methods = result.complete('this.components.');
        for (const name of ['value', 'get', 'set']) assert.ok(methods.some(entry => entry.name === name));
        const definitionPosition = sourceOffsetToGenerated(result.virtual, source.indexOf('this.components') + 6);
        const definitions = result.service.getDefinitionAtPosition(result.virtual.fileName, definitionPosition);
        const mapped = definitions.map(def => generatedSpanToSource(result.virtual, def.textSpan.start, def.textSpan.length)).filter(Boolean);
        assert.ok(mapped.some(span => span.start === source.indexOf('components:')));
      } finally {
        result.service.dispose();
      }
    });
  }
}

test('explicit logic fields are not overwritten by generated prop members', () => {
  const result = query(`@component {
  tag: 'example-test',
  props: { count: { type: Number, value: 0 } }
}
@logic {
  count = { value: 1 };
  increment() { this.count.value++; }
}
`);
  try {
    assert.deepEqual(result.diagnostics(), []);
    assert.doesNotMatch(result.virtual.code, /get count/);
  } finally {
    result.service.dispose();
  }
});

test('props infer primitive defaults and update when a declaration is removed', () => {
  const role = `@component {
  tag: 'example-test',
  props: { title: { value: 'Hello' }, count: { value: 0 }, enabled: { value: false } }
}`;
  const logic = `@logic {
  check() {
    this.title.value.toUpperCase();
    this.count.set(1);
    this.enabled.value = true;
    this.count.set('invalid');
  }
}`;
  const before = query(`${role}\n${logic}`);
  const after = query(`@component { tag: 'example-test' }\n${logic}`);
  try {
    assert.deepEqual(before.diagnostics().map(d => d.code), [2345]);
    assert.ok(after.diagnostics().some(d => [2339, 2551].includes(d.code)));
  } finally {
    before.service.dispose();
    after.service.dispose();
  }
});

test('demo component props support setComponents and selection logic', () => {
  const result = query(`@component {
  tag: 'okalit-demo-components',
  styles: ['./okalit-demo-components.css'],
  props: {
    components: { type: Array, value: [] }
  }
}
@logic {
  setComponents(components) { this.components.value = components; }
  onInit() {
    if (this.components.value.length > 0) this.select(this.components.value[0]);
  }
  select(component) { return component; }
}
`);
  try {
    const missing = result.diagnostics().filter(diagnostic =>
      [2339, 2551].includes(diagnostic.code) &&
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').includes("'components'"));
    assert.deepEqual(missing, []);
    assert.ok(result.complete('this.components.').some(entry => entry.name === 'value'));
  } finally {
    result.service.dispose();
  }
});
