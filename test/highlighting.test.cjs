const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Registry, parseRawGrammar } = require('vscode-textmate');
const { loadWASM, OnigScanner, OnigString } = require('vscode-oniguruma');

const root = path.resolve(__dirname, '..');
const extensions = [
  process.env.VSCODE_EXTENSIONS_PATH,
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions',
  '/usr/share/code/resources/app/extensions',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/resources/app/extensions'),
].filter(Boolean).find(directory => fs.existsSync(path.join(directory, 'html/syntaxes/html.tmLanguage.json')));

test('real HTML grammar preserves JavaScript scopes in text and quoted/unquoted Lit bindings', {
  skip: !extensions && 'Set VSCODE_EXTENSIONS_PATH to the editor built-in extensions directory to run real grammar integration.',
}, async () => {
  await loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
  const grammarFiles = new Map([
    ['source.okalit', path.join(root, 'syntaxes/okalit.tmLanguage.json')],
    ['okalit.html-injection', path.join(root, 'syntaxes/okalit-html-injection.tmLanguage.json')],
    ['text.html.basic', path.join(extensions, 'html/syntaxes/html.tmLanguage.json')],
    ['source.js', path.join(extensions, 'javascript/syntaxes/JavaScript.tmLanguage.json')],
    ['source.js.regexp', path.join(extensions, 'javascript/syntaxes/Regular Expressions (JavaScript).tmLanguage')],
  ]);
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new OnigScanner(patterns),
      createOnigString: text => new OnigString(text),
    }),
    loadGrammar: async scope => {
      const filename = grammarFiles.get(scope);
      return filename ? parseRawGrammar(fs.readFileSync(filename, 'utf8'), filename) : null;
    },
    getInjections: scope => ['source.okalit', 'text.html.basic'].includes(scope) ? ['okalit.html-injection'] : [],
  });
  try {
    const grammar = await registry.loadGrammar('source.okalit');
    let stack;
    function tokenize(line) {
      const result = grammar.tokenizeLine(line, stack);
      stack = result.ruleStack;
      return {
        scopesAt(text) {
          const index = line.indexOf(text);
          assert.notEqual(index, -1, text);
          return result.tokens.find(token => token.startIndex <= index && token.endIndex > index).scopes;
        },
      };
    }
    for (const header of ['@render {', '@template content {', '@template greeting(name) {']) {
      tokenize(header);
      for (const line of [
        '  <p>${this.configChannel.value.lang}</p>',
        '  <div .items=${this.globalMenuChannel.value.items}></div>',
        '  <div title="${this.configChannel.value.lang}"></div>',
        "  <div title='${this.configChannel.value.lang}'></div>",
        '  <button ?disabled=${this.configChannel.value.busy}>Save</button>',
        '  <button @click="${() => this.configChannel.set({ lang: \'en\' })}">Save</button>',
      ]) {
        const tokens = tokenize(line);
        const scopes = tokens.scopesAt('this.');
        assert.ok(scopes.includes('meta.embedded.expression.okalit'), `${line}: ${scopes}`);
        assert.ok(scopes.includes('source.js.embedded.okalit'), `${line}: ${scopes}`);
        assert.ok(scopes.some(scope => scope.startsWith('variable.language.this')), `${line}: ${scopes}`);
      }
      tokenize('  ${items.map(item => {');
      const nested = tokenize('    return { label: item.name, enabled: true };');
      assert.ok(nested.scopesAt('return').some(scope => scope.startsWith('keyword.control')));
      assert.ok(nested.scopesAt('true').some(scope => scope.startsWith('constant.language')));
      tokenize('  })}');
      const html = tokenize('  <span>Back to HTML</span>');
      assert.ok(!html.scopesAt('Back').includes('source.js.embedded.okalit'));
      const literal = tokenize('  <span>\\${literalText}</span>');
      assert.ok(!literal.scopesAt('literalText').includes('source.js.embedded.okalit'));
      const attribute = tokenize('  <div title="Plain attribute text"></div>');
      assert.ok(attribute.scopesAt('Plain').includes('string.quoted.double.html'));
      assert.ok(!attribute.scopesAt('Plain').includes('source.js.embedded.okalit'));
      tokenize('}');
      tokenize('@template lateralDrawer {');
      tokenize('  <ok-ui-drawer');
      tokenize('    .open=${this.checked.value}');
      const title = tokenize("    .title=${t('layout.sidebar')}");
      assert.ok(title.scopesAt('t(').includes('source.js.embedded.okalit'));
      const side = tokenize('    side="right"');
      assert.ok(!side.scopesAt('right').includes('source.js.embedded.okalit'), side.scopesAt('right').join(', '));
      tokenize('    @ui-close=${() => { this.checked.value = false; }}');
      tokenize('  >');
      tokenize('    <app-sidebar></app-sidebar>');
      tokenize('  </ok-ui-drawer>');
      tokenize('}');
      const render = tokenize('@render {');
      assert.ok(render.scopesAt('@render').includes('keyword.control.section.okalit'), render.scopesAt('@render').join(', '));
      tokenize('  ${this.checked.value ? this.lateralDrawer : ""}');
      tokenize('}');
      stack = undefined;
      for (const line of [
        '@script {',
        '  import { html, signal, t } from "@okalit/core";',
        '}',
        '@page {',
        "  tag: 'app-layout',",
        "  props: [{ active: { type: String, value: 'home' } }, { label: { type: String, value: '' } }],",
        "  styles: ['./app-layout.scss', '@styles/global.scss'],",
        '  channels: { globalMenuChannel: GlobalMenuChannel(), globalAlertChannel: GlobalAlertChannel() }',
        '}',
        '@logic {',
        '  checked = signal(false);',
        '  scrolled = signal(false);',
        '}',
        '@template lateralDrawer {',
        '  <ok-ui-drawer',
        '    .open=${this.checked.value}',
        "    .title=${t('layout.sidebar')}",
        '    side="right"',
        '    @ui-close=${() => { this.checked.value = false; }}',
        '  >',
        '    <app-sidebar></app-sidebar>',
        '  </ok-ui-drawer>',
        '}',
      ]) tokenize(line);
      const fullRender = tokenize('@render {');
      assert.ok(fullRender.scopesAt('@render').includes('keyword.control.section.okalit'), fullRender.scopesAt('@render').join(', '));
      tokenize('}');
      tokenize('@template empty() {}');
      tokenize('@render {');
      const following = tokenize('  ${this.configChannel.value}');
      assert.ok(following.scopesAt('this.').includes('source.js.embedded.okalit'));
      tokenize('}');
    }
    tokenize('@logic {');
    const logic = tokenize('  check() { return this.configChannel.value; }');
    assert.ok(logic.scopesAt('return').some(scope => scope.startsWith('keyword.control')), logic.scopesAt('return').join(', '));
    tokenize('}');
  } finally {
    registry.dispose();
  }
});
