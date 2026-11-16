const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const {
  createJavaScriptHost,
  coreSpanToSource,
  createVirtualDocument,
  generatedSpanToSource,
  sourceOffsetToGenerated,
} = require('../javascript-language-service');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okalit-intellisense-'));
  const write = (name, text) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text);
    return filename;
  };
  write('node_modules/@okalit/core/package.json', JSON.stringify({
    name: '@okalit/core', type: 'module', exports: './dist/index.js',
  }));
  write('node_modules/@okalit/core/dist/Okalit.js', 'export class Okalit { requestUpdate() {} }');
  write('node_modules/@okalit/core/dist/index.js', `
export { Okalit } from './Okalit.js';
export { AppMixin, PageMixin, ModuleMixin } from './mixins.js';`);
  write('node_modules/@okalit/core/dist/mixins.js', `
import { Okalit } from './Okalit.js';
/**
 * @param {typeof Okalit} Base - Base component.
 * @returns {typeof Okalit} Extended component.
 */
export const AppMixin = Base => class extends Base {
  /** @param {string} locale */
  async switchLocale(locale) {}
  /** @param {string} path */
  navigate(path) {}
};
/**
 * @param {typeof Okalit} Base
 * @returns {typeof Okalit}
 */
export const PageMixin = Base => class extends Base {
  get routeParams() { return { id: '1' }; }
  /** @param {string} name */
  safeParam(name) { return name; }
  backRoute() {}
};
/**
 * @param {typeof Okalit} Base
 * @returns {typeof Okalit}
 */
export const ModuleMixin = Base => class extends Base {
  get router() { return { path: '/' }; }
  /** @param {string} path */
  navigate(path) {}
};`);
  const documents = new Map();
  const virtuals = new Map();
  const errors = [];
  const host = createJavaScriptHost(ts, root, documents, name => {
    const sourceName = name.endsWith('.okalit.virtual.js')
      ? name.slice(0, -'.okalit.virtual.js'.length) + '.ok' : name;
    return virtuals.get(sourceName);
  }, error => errors.push(error));
  const service = ts.createLanguageService(host);
  return {
    root, write, host, service, errors,
    open(relative, source) {
      const filename = path.join(root, relative);
      documents.set(filename, { version: 1 });
      const virtual = createVirtualDocument(source, filename, ts);
      virtuals.set(filename, virtual);
      return {
        virtual,
        diagnostics: () => [
          ...service.getSyntacticDiagnostics(virtual.fileName),
          ...service.getSemanticDiagnostics(virtual.fileName),
        ].filter(d => d.start !== undefined && generatedSpanToSource(virtual, d.start, d.length || 0)),
        complete(text) {
          const offset = sourceOffsetToGenerated(virtual, source.indexOf(text) + text.length);
          return service.getCompletionsAtPosition(virtual.fileName, offset, {})?.entries || [];
        },
        definitions(text) {
          const offset = sourceOffsetToGenerated(virtual, source.indexOf(text) + 1);
          return service.getDefinitionAtPosition(virtual.fileName, offset) || [];
        },
      };
    },
    close() {
      service.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('alias imports resolve using the nearest project config, including JS-to-JS imports', () => {
  const project = fixture();
  try {
    project.write('app/jsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@core/*': ['src/core/*'] } },
    }));
    project.write('app/src/core/value.js', 'export const config = { lang: "es" };');
    const target = project.write('app/src/core/channel.js', `
import { config } from '@core/value.js';
export function GlobalConfigChannel() { return config; }`);
    const result = project.open('app/src/main.ok', `@script {
  import { GlobalConfigChannel } from '@core/channel.js';
}
@main { tag: 'test-main' }
@logic {
  run() { return GlobalConfigChannel().lang; }
}`);
    assert.deepEqual(result.diagnostics(), []);
    assert.ok(result.definitions('GlobalConfigChannel()').some(d => d.fileName === target));
    assert.equal(project.service.getSemanticDiagnostics(target).length, 0);
    const missing = project.open('app/src/missing.ok', `@script {
  import { config } from '@core/missing.js';
}
@logic { run() { return config; } }`);
    assert.ok(missing.diagnostics().some(d => d.code === 2307));
  } finally {
    project.close();
  }
});

test('paths from tsconfig extends resolve relative to the configuration that declares them', () => {
  const project = fixture();
  try {
    project.write('shared/base.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['lib/*'] } },
    }));
    const target = project.write('shared/lib/config.js', 'export const config = 1;');
    project.write('app/tsconfig.json', JSON.stringify({ extends: '../shared/base.json' }));
    const resolved = project.host.resolveModuleNames(['@shared/config.js'], path.join(project.root, 'app/src/main.okalit.virtual.js'));
    assert.equal(resolved[0].resolvedFileName, target);
  } finally {
    project.close();
  }
});

for (const [role, method, valid, invalid] of [
  ['main', 'switchLocale', "this.switchLocale('es'); this.navigate('/');", 'this.switchLocale(123);'],
  ['page', 'safeParam', "this.safeParam('id'); this.routeParams.id; this.backRoute();", 'this.safeParam(123);'],
  ['module', 'navigate', "this.navigate('/'); this.router.path;", 'this.navigate(123);'],
]) {
  test(`${role} inherits its actual mixin API, with typed parameters and unknown-method errors`, () => {
    const project = fixture();
    try {
      const result = project.open(`src/${role}.ok`, `@${role} { tag: 'test-${role}' }
@logic {
  run() { ${valid} ${invalid} this.notDeclared(); this.requestUpdate(); }
}`);
      const diagnostics = result.diagnostics();
      assert.equal(diagnostics.length, 2, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
      assert.ok(diagnostics.some(d => d.code === 2345));
      assert.ok(diagnostics.some(d => [2339, 2551].includes(d.code)));
      assert.ok(result.complete('this.').some(entry => entry.name === method));
      const definition = result.definitions(`${method}(`).find(d => d.fileName.endsWith('/mixins.js'));
      assert.ok(definition);
      const original = fs.readFileSync(definition.fileName, 'utf8');
      const mapped = coreSpanToSource(original, definition.fileName, definition.textSpan, ts);
      assert.equal(original.slice(mapped.start, mapped.start + mapped.length), method);
    } finally {
      project.close();
    }
  });
}

test('component role does not acquire application-only methods', () => {
  const project = fixture();
  try {
    const result = project.open('src/component.ok', `@component { tag: 'test-component' }
@logic { run() { this.switchLocale('es'); this.requestUpdate(); } }`);
    assert.deepEqual(result.diagnostics().map(d => d.code), [2339]);
  } finally {
    project.close();
  }
});

test('invalid editor configuration surfaces errors instead of silently ignoring them', () => {
  const project = fixture();
  try {
    project.write('jsconfig.json', '{ "compilerOptions": { "paths": ');
    project.host.resolveModuleNames(['@missing/config'], path.join(project.root, 'src/main.okalit.virtual.js'));
    assert.ok(project.errors.length > 0);
  } finally {
    project.close();
  }
});

test('configuration refresh resolves a previously missing alias', () => {
  const project = fixture();
  try {
    const result = project.open('src/main.ok', `@script {
  import { config } from '@core/config.js';
}
@logic { run() { return config; } }`);
    assert.ok(result.diagnostics().some(d => d.code === 2307));
    project.write('src/core/config.js', 'export const config = 1;');
    project.write('jsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@core/*': ['src/core/*'] } },
    }));
    project.service.cleanupSemanticCache();
    assert.deepEqual(result.diagnostics(), []);
  } finally {
    project.close();
  }
});

test('legacy signal annotations retain the actual value wrapper without hiding unknown members', () => {
  const project = fixture();
  try {
    project.write('node_modules/@okalit/core/dist/index.js', `
import { signal } from './signals.js';
export { Okalit } from './Okalit.js';
export { signal, computed } from './signals.js';
export function getI18n() { return { locale: signal('es') }; }`);
    const target = project.write('node_modules/@okalit/core/dist/signals.js', `
class State {
  constructor(value) { this.current = value; }
  get() { return this.current; }
  set(value) { this.current = value; }
}
const Signal = { State, Computed: State };
class ValueState extends Signal.State {
  get value() { return this.get(); }
  set value(value) { this.set(value); }
}
class ValueComputed extends Signal.Computed {
  get value() { return this.get(); }
}
/** @param {*} value
 * @returns {Signal.State}
 */
export const signal = value => new ValueState(value);
/** @param {() => *} fn
 * @returns {Signal.Computed}
 */
export const computed = fn => new ValueComputed(fn());
`);
    const original = fs.readFileSync(target, 'utf8');
    const result = project.open('src/main.ok', `@script {
  import { getI18n, computed } from '@okalit/core';
}
@logic {
  run() {
    const i18n = getI18n();
    i18n.locale.value = 'en';
    i18n.locale.get();
    i18n.locale.set('es');
    computed(() => 'es').value;
    i18n.locale.unknown();
  }
}`);
    assert.deepEqual(result.diagnostics().map(d => d.code), [2339]);
    assert.ok(result.complete('i18n.locale.').some(entry => entry.name === 'value'));
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  } finally {
    project.close();
  }
});

for (const role of ['component', 'page', 'module', 'main']) {
  test(`${role} template getters and methods resolve in logic, render and other templates`, () => {
    const project = fixture();
    try {
      project.write('node_modules/@okalit/core/dist/index.js', `
export { Okalit } from './Okalit.js';
export { AppMixin, PageMixin, ModuleMixin } from './mixins.js';
export function html(strings, ...values) { return { strings, values }; }`);
      const source = `@${role} { tag: 'test-template' }
@template content {
  <h1>Welcome</h1>
}
@template greeting(name = 'Ada') {
  <p>Hello, \${name.toUpperCase()}</p>
  \${this.content}
}
@template empty() {}
@logic {
  chooseContent(show) {
    return show ? this.content : this.greeting('Ada');
  }
}
@render {
  \${this.chooseContent(true)}
  \${this.greeting('Ada')}
  \${this.empty()}
  \${this.missingTemplate}
}
`;
      const result = project.open(`src/${role}.ok`, source);
      const diagnostics = result.diagnostics();
      assert.deepEqual(diagnostics.map(d => d.code), [2339]);
      const mapped = generatedSpanToSource(result.virtual, diagnostics[0].start, diagnostics[0].length);
      assert.equal(source.slice(mapped.start, mapped.start + mapped.length), 'missingTemplate');
      assert.ok(result.complete('this.').some(entry => entry.name === 'greeting'));
      const definition = result.definitions('content}').find(d => d.fileName === result.virtual.fileName);
      assert.ok(definition);
      assert.equal(generatedSpanToSource(result.virtual, definition.textSpan.start, definition.textSpan.length).start,
        source.indexOf('content {'));
      const quickInfo = project.service.getQuickInfoAtPosition(result.virtual.fileName,
        sourceOffsetToGenerated(result.virtual, source.indexOf('this.greeting') + 6));
      assert.match(ts.displayPartsToString(quickInfo.displayParts), /name\?: string/);
      const references = project.service.getReferencesAtPosition(result.virtual.fileName,
        sourceOffsetToGenerated(result.virtual, source.indexOf('content {')));
      assert.equal(references.length, 3);
    } finally {
      project.close();
    }
  });
}

test('template parameters and HTML expressions retain errors without diagnosing HTML text', () => {
  const project = fixture();
  try {
    project.write('node_modules/@okalit/core/dist/index.js', `
export { Okalit } from './Okalit.js';
export function html(strings, ...values) { return { strings, values }; }`);
    const source = `@component { tag: 'test-template' }
@template message(name = 'Ada') {
  <p>plainTextIsNotJavaScript</p>
  \${name.missingMethod()}
  \${unknownVariable}
}
@template content {
  <p>Content</p>
}
@render {
  \${this.message(123)}
  \${this.content()}
}
`;
    const result = project.open('src/template.ok', source);
    assert.deepEqual(result.diagnostics().map(d => d.code).sort(), [2304, 2339, 2345, 6234]);
    assert.ok(result.complete('name.').some(entry => entry.name === 'toUpperCase'));
  } finally {
    project.close();
  }
});
