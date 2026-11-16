const path = require('node:path');

const SECTION_NAMES = new Set([
  'script',
  'logic',
  'render',
  'component',
  'page',
  'module',
  'main',
  'template',
]);

function skipWhitespaceAndComments(source, start) {
  let index = start;

  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++;
    } else if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline + 1;
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) return source.length;
      index = close + 2;
    } else {
      break;
    }
  }

  return index;
}

function findBalancedEnd(source, openIndex, ts, openToken, closeToken) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source.slice(openIndex),
  );
  let depth = 0;
  let braces = 0;
  const templates = [];
  let previous;

  while (true) {
    let token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return source.length;
    if ((token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
        [undefined, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBraceToken,
          ts.SyntaxKind.EqualsToken, ts.SyntaxKind.EqualsGreaterThanToken,
          ts.SyntaxKind.CommaToken, ts.SyntaxKind.ColonToken, ts.SyntaxKind.ReturnKeyword,
          ts.SyntaxKind.QuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(previous)) {
      token = scanner.reScanSlashToken();
    }
    if (token === ts.SyntaxKind.TemplateHead) templates.push(braces);
    else if (token === ts.SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
      token = scanner.reScanTemplateToken(false);
      if (token === ts.SyntaxKind.TemplateTail) templates.pop();
    } else if (token === ts.SyntaxKind.OpenBraceToken) braces++;
    else if (token === ts.SyntaxKind.CloseBraceToken) braces--;
    if (token === openToken) depth++;
    if (token === closeToken && --depth === 0) {
      return openIndex + scanner.getTokenPos();
    }
    previous = token;
  }
}

function findCodeSectionEnd(source, openIndex, ts) {
  return findBalancedEnd(source, openIndex, ts, ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken);
}

function findRenderSectionEnd(source, openIndex, ts) {
  for (let index = openIndex + 1; index < source.length; index++) {
    if (source.startsWith('${', index) && !isEscaped(source, index)) {
      index = findCodeSectionEnd(source, index + 1, ts);
    } else if (source[index] === '}') {
      const lineStart = source.lastIndexOf('\n', index - 1) + 1;
      const newline = source.indexOf('\n', index);
      if ((!source.slice(lineStart, index).trim() || !source.slice(openIndex + 1, index).trim()) &&
          !source.slice(index + 1, newline === -1 ? source.length : newline).trim()) return index;
    }
  }
  return source.length;
}

function isEscaped(source, index) {
  let backslashes = 0;
  while (index > 0 && source[--index] === '\\') backslashes++;
  return backslashes % 2 !== 0;
}

function extractSections(source, ts) {
  const sections = new Map();
  let cursor = 0;

  while ((cursor = skipWhitespaceAndComments(source, cursor)) < source.length) {
    const marker = source.slice(cursor).match(/^@([A-Za-z][A-Za-z0-9_-]*)/);
    if (!marker || !SECTION_NAMES.has(marker[1])) break;

    let openIndex = cursor + marker[0].length;
    let template;
    if (marker[1] === 'template') {
      openIndex = skipWhitespaceAndComments(source, openIndex);
      const name = source.slice(openIndex).match(/^[$_\p{ID_Start}][$\u200C\u200D_\p{ID_Continue}]*/u);
      if (!name) break;
      template = { name: name[0], nameStart: openIndex, hasParameters: false, params: '' };
      openIndex = skipWhitespaceAndComments(source, openIndex + name[0].length);
      if (source[openIndex] === '(') {
        template.hasParameters = true;
        template.paramsStart = openIndex + 1;
        const end = findBalancedEnd(source, openIndex, ts, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken);
        template.params = source.slice(openIndex + 1, end);
        openIndex = skipWhitespaceAndComments(source, end + 1);
      }
    }
    while (/\s/.test(source[openIndex] || '')) openIndex++;
    if (source[openIndex] !== '{') break;

    const end = marker[1] === 'render' || template
      ? findRenderSectionEnd(source, openIndex, ts)
      : findCodeSectionEnd(source, openIndex, ts);
    const key = template ? `template:${cursor}` : marker[1];
    if (!sections.has(key)) {
      sections.set(key, {
        ...template,
        bodyStart: openIndex + 1,
        bodyEnd: end,
        body: source.slice(openIndex + 1, end),
      });
    }
    cursor = end < source.length ? end + 1 : source.length;
  }

  return sections;
}

function createVirtualDocument(source, filename, ts) {
  const sections = extractSections(source, ts);
  const segments = [];
  let code = '';

  const append = (text, sectionName) => {
    const start = code.length;
    code += text;
    if (sectionName) {
      const section = sections.get(sectionName);
      segments.push({
        sectionName,
        sourceStart: section.bodyStart,
        sourceEnd: section.bodyEnd,
        generatedStart: start,
        generatedEnd: code.length,
      });
    }
  };

  const roleMixin = ['main', 'page', 'module'].find(role => sections.has(role));
  const mixins = { main: 'AppMixin', page: 'PageMixin', module: 'ModuleMixin' };
  append(`import { Okalit as __Oakalit, html as __OakalitHtml${roleMixin ? `, ${mixins[roleMixin]} as __OakalitRoleMixin` : ''} } from '@okalit/core';\n`);
  if (sections.has('script')) append(sections.get('script').body, 'script');
  append(`\nconst __okalitConfig = {};\nclass __OakalitIntellisense extends ${roleMixin ? '__OakalitRoleMixin(__Oakalit)' : '__Oakalit'} {\n`);
  const props = extractReactiveProps(sections, ts);
  for (const prop of props) {
    const signalType = `{ value: ${prop.type}, get: () => ${prop.type}, set: (value: ${prop.type}) => void }`;
    append(`\n/** @returns {${signalType}} */\nget `);
    const generatedStart = code.length;
    append(prop.name);
    segments.push({
      sectionName: 'prop',
      sourceStart: prop.sourceStart,
      sourceEnd: prop.sourceStart + prop.name.length,
      generatedStart,
      generatedEnd: code.length,
    });
    append(`() { throw new Error('Virtual reactive property'); }\n`);
    append(`/** @param {${prop.type} | ${signalType}} value */\nset ${prop.name}(value) {}\n`);
  }
  if (sections.has('logic')) append(sections.get('logic').body, 'logic');
  const appendMapped = (text, sourceStart, sectionName) => {
    const generatedStart = code.length;
    append(text);
    segments.push({
      sectionName, sourceStart, sourceEnd: sourceStart + text.length,
      generatedStart, generatedEnd: code.length,
    });
  };
  for (const [key, section] of sections) {
    if (!key.startsWith('template:')) continue;
    append(`\n${section.hasParameters ? '' : 'get '}`);
    appendMapped(section.name, section.nameStart, 'template-name');
    append('(');
    if (section.hasParameters) appendMapped(section.params, section.paramsStart, 'template-params');
    append(') {\nreturn __OakalitHtml`');
    append(section.body, key);
    append('`;\n}\n');
  }
  if (sections.has('render')) {
    append('\nrender() {\nreturn __OakalitHtml`');
    append(sections.get('render').body, 'render');
    append('`;\n}\n');
  }
  append('\n}\n');

  return {
    sourceFileName: path.resolve(filename),
    fileName: `${path.resolve(filename).replace(/\.ok$/i, '')}.okalit.virtual.js`,
    code,
    segments,
  };
}

function extractReactiveProps(sections, ts) {
  const role = ['component', 'page', 'module', 'main'].find(name => sections.has(name));
  if (!role) return [];
  const section = sections.get(role);
  const prefix = 'const config = ({';
  const file = ts.createSourceFile('role.js', `${prefix}${section.body}});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const expression = file.statements[0]?.declarationList?.declarations[0]?.initializer;
  if (!expression || !ts.isParenthesizedExpression(expression) || !ts.isObjectLiteralExpression(expression.expression)) return [];
  const propertyName = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
  const props = expression.expression.properties.find(property => propertyName(property.name) === 'props');
  if (!props || !ts.isPropertyAssignment(props)) return [];
  const definitions = ts.isArrayLiteralExpression(props.initializer) ? props.initializer.elements : [props.initializer];
  const result = new Map();
  const types = { String: 'string', Number: 'number', Boolean: 'boolean', Array: 'Array<any>', Object: 'Object', Date: 'Date' };
  for (const definition of definitions) {
    if (!ts.isObjectLiteralExpression(definition)) continue;
    for (const property of definition.properties) {
      const name = propertyName(property.name);
      if (!name || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
      const type = property.initializer.properties.find(item => propertyName(item.name) === 'type');
      const value = property.initializer.properties.find(item => propertyName(item.name) === 'value');
      let inferred = '*';
      if (type && ts.isPropertyAssignment(type) && ts.isIdentifier(type.initializer)) {
        inferred = types[type.initializer.text] || `InstanceType<typeof ${type.initializer.text}>`;
      } else if (value && ts.isPropertyAssignment(value)) {
        const initial = value.initializer;
        if (ts.isStringLiteral(initial)) inferred = 'string';
        else if (ts.isNumericLiteral(initial)) inferred = 'number';
        else if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(initial.kind)) inferred = 'boolean';
        else if (ts.isArrayLiteralExpression(initial)) inferred = 'Array<any>';
        else if (ts.isObjectLiteralExpression(initial)) inferred = 'Object';
      }
      result.set(name, {
        name: property.name.getText(file),
        type: inferred,
        sourceStart: section.bodyStart + property.name.getStart(file) - prefix.length,
      });
    }
  }
  // Explicit class members already participate in normal JavaScript inference.
  const logic = sections.get('logic');
  if (logic) {
    const file = ts.createSourceFile('logic.js', `class Logic {${logic.body}}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const member of file.statements[0]?.members || []) result.delete(propertyName(member.name));
  }
  return [...result.values()];
}

function findSegmentAtSourceOffset(virtualDocument, offset) {
  return virtualDocument.segments.find(({ sourceStart, sourceEnd }) => (
    offset >= sourceStart && offset <= sourceEnd
  ));
}

function sourceOffsetToGenerated(virtualDocument, offset) {
  const segment = findSegmentAtSourceOffset(virtualDocument, offset);
  return segment ? segment.generatedStart + offset - segment.sourceStart : null;
}

function generatedSpanToSource(virtualDocument, start, length) {
  const segment = virtualDocument.segments.find(({ generatedStart, generatedEnd }) => (
    start >= generatedStart && start + length <= generatedEnd
  ));
  if (!segment) return null;

  return {
    start: segment.sourceStart + start - segment.generatedStart,
    length,
  };
}

function originalFileName(fileName) {
  return fileName.endsWith('.okalit.virtual.js')
    ? `${fileName.slice(0, -'.okalit.virtual.js'.length)}.ok`
    : path.resolve(fileName);
}

function readProjectOptions(fileName, ts, reportError) {
  let directory = path.dirname(fileName);
  let configFile;
  while (true) {
    configFile = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(directory, name)).find(ts.sys.fileExists);
    if (configFile) break;
    const parent = path.dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
  const result = ts.readConfigFile(configFile, ts.sys.readFile);
  if (result.error) {
    reportError(result.error);
    return {};
  }
  const parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, path.dirname(configFile), undefined, configFile);
  // .ok-only projects legitimately have no TypeScript-recognized input files.
  for (const error of parsed.errors) if (error.code !== 18003) reportError(error);
  return parsed.options;
}

function normalizeCoreTypes(text, fileName, ts) {
  if (!/[\\/]@okalit[\\/]core[\\/](?:src|dist)[\\/](?:mixins|signals)\.js$/.test(fileName)) return { text, patches: [] };
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const patches = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const name = statement.declarationList.declarations[0]?.name;
    if (!name || !ts.isIdentifier(name)) continue;
    for (const doc of statement.jsDoc || []) {
      const tags = doc.tags || [];
      const parameter = tags.find(tag => ts.isJSDocParameterTag(tag) && tag.name.getText(file) === 'Base');
      const returns = tags.find(tag => ts.isJSDocReturnTag(tag));
      if (path.basename(fileName) === 'signals.js') {
        const expected = { signal: ['ValueState', 'Signal.State'], computed: ['ValueComputed', 'Signal.Computed'] }[name.text];
        const initializer = statement.declarationList.declarations[0].initializer;
        if (expected && initializer && ts.isArrowFunction(initializer) && ts.isNewExpression(initializer.body) &&
            initializer.body.expression.getText(file) === expected[0] &&
            returns?.typeExpression?.type.getText(file) === expected[1]) {
          // Infer the actual wrapper, which adds .value to the upstream signal.
          patches.push({ start: returns.getStart(file), end: returns.end, text: '' });
        }
        continue;
      }
      if (!['AppMixin', 'PageMixin', 'ModuleMixin', 'SubscribeChannelsMixin'].includes(name.text)) continue;
      if (parameter?.typeExpression?.type.getText(file) !== 'typeof Okalit' ||
          returns?.typeExpression?.type.getText(file) !== 'typeof Okalit') continue;
      // Older core releases annotate the return as the base class, hiding every
      // added method. Infer the returned class while preserving the base type.
      patches.push({
        start: parameter.getStart(file),
        end: parameter.end,
        text: "@template {typeof import('./Okalit.js').Okalit} T\n * @param {T} Base\n * ",
      }, { start: returns.getStart(file), end: returns.end, text: '' });
    }
  }
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, patch.start) + patch.text + text.slice(patch.end);
  }
  return { text, patches };
}

function coreSpanToSource(text, fileName, span, ts) {
  const { patches } = normalizeCoreTypes(text, fileName, ts);
  const mapOffset = offset => {
    let shift = 0;
    for (const patch of [...patches].sort((a, b) => a.start - b.start)) {
      const generatedStart = patch.start + shift;
      if (offset < generatedStart) break;
      if (offset < generatedStart + patch.text.length) return patch.start;
      shift += patch.text.length - (patch.end - patch.start);
    }
    return offset - shift;
  };
  const start = mapOffset(span.start);
  return { start, length: mapOffset(span.start + span.length) - start };
}

function createJavaScriptHost(ts, rootPath, documents, getVirtualDocument, reportError) {
  const defaults = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
    maxNodeModuleJsDepth: 3,
  };
  const optionsFor = fileName => ({ ...readProjectOptions(fileName, ts, reportError), ...defaults });
  const host = {
    getCompilationSettings: () => optionsFor(path.join(rootPath, 'index.js')),
    getCurrentDirectory: () => rootPath,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getScriptFileNames: () => [...documents.keys()].map((fileName) => getVirtualDocument(fileName).fileName),
    getScriptVersion: (fileName) => String(documents.get(originalFileName(path.resolve(fileName)))?.version ??
      ts.sys.getModifiedTime?.(originalFileName(fileName))?.getTime() ?? 0),
    getScriptKind: fileName => /\.tsx?$/.test(fileName) ? (fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : ts.ScriptKind.JS,
    getScriptSnapshot: (fileName) => {
      const normalized = path.resolve(fileName);
      if (normalized.endsWith('.okalit.virtual.js')) {
        const virtualDocument = getVirtualDocument(normalized);
        return virtualDocument ? ts.ScriptSnapshot.fromString(virtualDocument.code) : undefined;
      }

      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(normalizeCoreTypes(text, fileName, ts).text);
    },
    fileExists: (fileName) => fileName.endsWith('.okalit.virtual.js') || ts.sys.fileExists(fileName),
    readFile: (fileName) => fileName.endsWith('.okalit.virtual.js')
      ? getVirtualDocument(fileName)?.code
      : ts.sys.readFile(fileName),
    readDirectory: (...args) => ts.sys.readDirectory(...args),
    directoryExists: (directoryName) => ts.sys.directoryExists?.(directoryName) ?? false,
    getDirectories: (directoryName) => ts.sys.getDirectories?.(directoryName) ?? [],
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    resolveModuleNames: (names, containingFile) => names.map(name =>
      ts.resolveModuleName(name, containingFile, optionsFor(containingFile), host).resolvedModule),
  };
  return host;
}

function createLanguageService(vscode, context) {
  const ts = require('typescript');
  const documents = new Map();
  const virtualDocuments = new Map();
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ts.sys.getCurrentDirectory();
  const getVirtualDocument = (fileName) => {
    const sourceFileName = originalFileName(path.resolve(fileName));
    const document = documents.get(sourceFileName);
    const source = document?.getText() ?? ts.sys.readFile(sourceFileName);
    if (source === undefined) return null;

    const version = document?.version ?? 0;
    const cached = virtualDocuments.get(sourceFileName);
    if (cached?.version === version && cached.source === source) return cached.virtualDocument;

    const virtualDocument = createVirtualDocument(source, sourceFileName, ts);
    virtualDocuments.set(sourceFileName, { version, source, virtualDocument });
    return virtualDocument;
  };
  const reportedErrors = new Set();
  const reportError = diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const key = `${diagnostic.file?.fileName || ''}:${diagnostic.start || 0}:${message}`;
    if (!reportedErrors.has(key)) {
      reportedErrors.add(key);
      vscode.window.showErrorMessage(`Okalit project configuration: ${message}`);
    }
  };
  const host = createJavaScriptHost(ts, rootPath, documents, getVirtualDocument, reportError);
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('okalit-javascript');
  const diagnosticTimers = new Map();
  context.subscriptions.push(diagnosticCollection, {
    dispose() {
      for (const timer of diagnosticTimers.values()) clearTimeout(timer);
      diagnosticTimers.clear();
    },
  });

  const syncDocuments = (document) => {
    for (const openDocument of vscode.workspace.textDocuments) {
      if (openDocument.languageId === 'okalit') {
        documents.set(path.resolve(openDocument.uri.fsPath), openDocument);
      }
    }
    documents.set(path.resolve(document.uri.fsPath), document);
  };

  const getQuery = (document, position) => {
    if (document.uri.scheme !== 'file') return null;
    syncDocuments(document);
    const fileName = path.resolve(document.uri.fsPath);
    const virtualDocument = getVirtualDocument(fileName);
    if (!virtualDocument) return null;
    const sourceOffset = document.offsetAt(position);
    const generatedOffset = sourceOffsetToGenerated(virtualDocument, sourceOffset);
    if (generatedOffset === null) return null;
    return { fileName: virtualDocument.fileName, sourceFileName: fileName, generatedOffset, virtualDocument };
  };

  const sourceLocation = (fileName, textSpan) => {
    const normalized = path.resolve(fileName);
    if (!normalized.endsWith('.okalit.virtual.js')) {
      const source = ts.sys.readFile(fileName);
      if (source === undefined) return null;
      const span = coreSpanToSource(source, fileName, textSpan, ts);
      const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
      const start = file.getLineAndCharacterOfPosition(span.start);
      const end = file.getLineAndCharacterOfPosition(span.start + span.length);
      return new vscode.Location(
        vscode.Uri.file(fileName),
        new vscode.Range(
          new vscode.Position(start.line, start.character),
          new vscode.Position(end.line, end.character),
        ),
      );
    }

    const target = getVirtualDocument(originalFileName(normalized));
    const mapped = target && generatedSpanToSource(target, textSpan.start, textSpan.length);
    const document = documents.get(target?.sourceFileName);
    if (!mapped || !document) return null;

    return new vscode.Location(
      document.uri,
      new vscode.Range(
        document.positionAt(mapped.start),
        document.positionAt(mapped.start + mapped.length),
      ),
    );
  };

  const updateDiagnostics = (document) => {
    if (document.uri.scheme !== 'file') return;
    const fileName = path.resolve(document.uri.fsPath);
    const oldTimer = diagnosticTimers.get(fileName);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(() => {
      diagnosticTimers.delete(fileName);
      syncDocuments(document);
      const virtualDocument = getVirtualDocument(fileName);
      if (!virtualDocument) return;

      const diagnostics = [
        ...service.getSyntacticDiagnostics(virtualDocument.fileName),
        ...service.getSemanticDiagnostics(virtualDocument.fileName),
      ].flatMap((diagnostic) => {
        if (diagnostic.start === undefined) return [];
        const mapped = generatedSpanToSource(
          virtualDocument,
          diagnostic.start,
          diagnostic.length ?? 0,
        );
        if (!mapped) return [];

        const severity = {
          [ts.DiagnosticCategory.Error]: vscode.DiagnosticSeverity.Error,
          [ts.DiagnosticCategory.Warning]: vscode.DiagnosticSeverity.Warning,
          [ts.DiagnosticCategory.Suggestion]: vscode.DiagnosticSeverity.Information,
          [ts.DiagnosticCategory.Message]: vscode.DiagnosticSeverity.Hint,
        }[diagnostic.category];
        const result = new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(mapped.start),
            document.positionAt(mapped.start + mapped.length),
          ),
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          severity,
        );
        result.source = 'JavaScript';
        result.code = diagnostic.code;
        return [result];
      });

      diagnosticCollection.set(document.uri, diagnostics);
    }, 200);
    diagnosticTimers.set(fileName, timer);
  };

  const provider = {
    provideCompletionItems(document, position) {
      const query = getQuery(document, position);
      if (!query) return undefined;
      const info = service.getCompletionsAtPosition(
        query.fileName,
        query.generatedOffset,
        {
          includeCompletionsForModuleExports: true,
          includeInsertTextCompletions: true,
          includeCompletionsWithInsertText: true,
        },
      );
      if (!info) return undefined;

      return info.entries.map((entry) => {
        const item = new vscode.CompletionItem(
          entry.name,
          completionKind(vscode, entry.kind),
        );
        item.sortText = entry.sortText;
        item.filterText = entry.name;
        item.insertText = entry.insertText || entry.name;
        item.detail = entry.sourceDisplay?.map((part) => part.text).join('');
        const replacement = entry.replacementSpan || info.optionalReplacementSpan;
        if (replacement) {
          const mapped = generatedSpanToSource(
            query.virtualDocument,
            replacement.start,
            replacement.length,
          );
          if (mapped) {
            item.range = new vscode.Range(
              document.positionAt(mapped.start),
              document.positionAt(mapped.start + mapped.length),
            );
          }
        }
        item.data = {
          fileName: query.fileName,
          position: query.generatedOffset,
          name: entry.name,
          source: entry.source,
          data: entry.data,
        };
        return item;
      });
    },
    async resolveCompletionItem(item) {
      if (!item.data) return item;
      const { fileName, position, name, source, data } = item.data;
      const details = service.getCompletionEntryDetails(
        fileName,
        position,
        name,
        {},
        source,
        {},
        data,
      );
      if (details) {
        const documentation = ts.displayPartsToString(details.documentation);
        item.detail = ts.displayPartsToString(details.displayParts);
        if (documentation) item.documentation = new vscode.MarkdownString(documentation);
        const edits = [];
        for (const action of details.codeActions || []) {
          for (const fileChanges of action.changes) {
            for (const change of fileChanges.textChanges) {
              const targetPath = path.resolve(fileChanges.fileName);
              if (targetPath === path.resolve(fileName)) {
                const targetVirtual = getVirtualDocument(targetPath);
                let mapped = targetVirtual && generatedSpanToSource(
                  targetVirtual,
                  change.span.start,
                  change.span.length,
                );
                let newText = change.newText;
                if (!mapped && change.span.length === 0 && targetVirtual) {
                  const script = targetVirtual.segments.find(({ sectionName }) => sectionName === 'script');
                  if (script) {
                    mapped = { start: script.sourceStart, length: 0 };
                  } else {
                    mapped = { start: 0, length: 0 };
                    newText = `@script {\n${newText}}\n\n`;
                  }
                }
                if (mapped) {
                  const targetDocument = documents.get(targetVirtual.sourceFileName);
                  if (targetDocument) {
                    edits.push(new vscode.TextEdit(
                      new vscode.Range(
                        targetDocument.positionAt(mapped.start),
                        targetDocument.positionAt(mapped.start + mapped.length),
                      ),
                      newText,
                    ));
                  }
                }
              } else {
                const targetSource = ts.sys.readFile(fileChanges.fileName);
                if (targetSource === undefined) continue;
                const start = ts.getLineAndCharacterOfPosition(targetSource, change.span.start);
                const end = ts.getLineAndCharacterOfPosition(
                  targetSource,
                  change.span.start + change.span.length,
                );
                edits.push(new vscode.TextEdit(
                  new vscode.Range(
                    new vscode.Position(start.line, start.character),
                    new vscode.Position(end.line, end.character),
                  ),
                  change.newText,
                ));
              }
            }
          }
        }
        if (edits.length) item.additionalTextEdits = edits;
      }
      delete item.data;
      return item;
    },
    provideHover(document, position) {
      const query = getQuery(document, position);
      if (!query) return undefined;
      const info = service.getQuickInfoAtPosition(query.fileName, query.generatedOffset);
      if (!info) return undefined;

      const contents = new vscode.MarkdownString();
      contents.appendCodeblock(ts.displayPartsToString(info.displayParts), 'javascript');
      const documentation = ts.displayPartsToString(info.documentation);
      if (documentation) contents.appendMarkdown(`\n\n${documentation}`);
      const mapped = generatedSpanToSource(
        query.virtualDocument,
        info.textSpan.start,
        info.textSpan.length,
      );
      return new vscode.Hover(
        contents,
        mapped
          ? new vscode.Range(document.positionAt(mapped.start), document.positionAt(mapped.start + mapped.length))
          : undefined,
      );
    },
    provideDefinition(document, position) {
      const query = getQuery(document, position);
      if (!query) return undefined;
      const definitions = service.getDefinitionAtPosition(query.fileName, query.generatedOffset) || [];
      return definitions
        .map((definition) => sourceLocation(definition.fileName, definition.textSpan))
        .filter(Boolean);
    },
    provideReferences(document, position) {
      const query = getQuery(document, position);
      if (!query) return undefined;
      const references = service.getReferencesAtPosition(query.fileName, query.generatedOffset) || [];
      return references
        .map((reference) => sourceLocation(reference.fileName, reference.textSpan))
        .filter(Boolean);
    },
    provideSignatureHelp(document, position) {
      const query = getQuery(document, position);
      if (!query) return undefined;
      const help = service.getSignatureHelpItems(
        query.fileName,
        query.generatedOffset,
        undefined,
      );
      if (!help) return undefined;

      const result = new vscode.SignatureHelp();
      result.signatures = help.items.map((signature) => {
        const item = new vscode.SignatureInformation(
          ts.displayPartsToString(signature.prefixDisplayParts) +
            signature.parameters.map((parameter, index) => (
              `${index > 0 ? ts.displayPartsToString(signature.separatorDisplayParts) : ''}` +
              ts.displayPartsToString(parameter.displayParts)
            )).join('') +
            ts.displayPartsToString(signature.suffixDisplayParts),
          ts.displayPartsToString(signature.documentation),
        );
        item.parameters = signature.parameters.map((parameter) => (
          new vscode.ParameterInformation(
            ts.displayPartsToString(parameter.displayParts),
            ts.displayPartsToString(parameter.documentation),
          )
        ));
        return item;
      });
      result.activeSignature = help.selectedItemIndex;
      result.activeParameter = help.argumentIndex;
      return result;
    },
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === 'okalit') {
        documents.set(path.resolve(document.uri.fsPath), document);
        updateDiagnostics(document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      documents.delete(path.resolve(document.uri.fsPath));
      virtualDocuments.delete(path.resolve(document.uri.fsPath));
      const fileName = path.resolve(document.uri.fsPath);
      const timer = diagnosticTimers.get(fileName);
      if (timer) clearTimeout(timer);
      diagnosticTimers.delete(fileName);
      diagnosticCollection.delete(document.uri);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document.languageId === 'okalit') {
        documents.set(path.resolve(document.uri.fsPath), document);
        virtualDocuments.delete(path.resolve(document.uri.fsPath));
        updateDiagnostics(document);
      }
    }),
    vscode.languages.registerHoverProvider('okalit', provider),
    vscode.languages.registerDefinitionProvider('okalit', provider),
    vscode.languages.registerReferenceProvider('okalit', provider),
    vscode.languages.registerSignatureHelpProvider('okalit', provider, '(', ','),
  );

  const configWatcher = vscode.workspace.createFileSystemWatcher('**/{jsconfig,tsconfig}.json');
  const refreshConfiguration = () => {
    reportedErrors.clear();
    service.cleanupSemanticCache();
    for (const document of documents.values()) updateDiagnostics(document);
  };
  context.subscriptions.push(
    configWatcher,
    configWatcher.onDidCreate(refreshConfiguration),
    configWatcher.onDidChange(refreshConfiguration),
    configWatcher.onDidDelete(refreshConfiguration),
    { dispose: () => service.dispose() },
  );

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === 'okalit') {
      documents.set(path.resolve(document.uri.fsPath), document);
      updateDiagnostics(document);
    }
  }

  return provider;
}

function completionKind(vscode, kind) {
  const kinds = {
    class: vscode.CompletionItemKind.Class,
    const: vscode.CompletionItemKind.Constant,
    constructor: vscode.CompletionItemKind.Constructor,
    enum: vscode.CompletionItemKind.Enum,
    field: vscode.CompletionItemKind.Field,
    function: vscode.CompletionItemKind.Function,
    interface: vscode.CompletionItemKind.Interface,
    keyword: vscode.CompletionItemKind.Keyword,
    let: vscode.CompletionItemKind.Variable,
    localFunction: vscode.CompletionItemKind.Function,
    localVar: vscode.CompletionItemKind.Variable,
    method: vscode.CompletionItemKind.Method,
    memberVariable: vscode.CompletionItemKind.Field,
    module: vscode.CompletionItemKind.Module,
    parameter: vscode.CompletionItemKind.Variable,
    property: vscode.CompletionItemKind.Property,
    var: vscode.CompletionItemKind.Variable,
    warning: vscode.CompletionItemKind.Text,
  };
  return kinds[kind] || vscode.CompletionItemKind.Text;
}

module.exports = {
  coreSpanToSource,
  createJavaScriptHost,
  createLanguageService,
  createVirtualDocument,
  extractSections,
  generatedSpanToSource,
  sourceOffsetToGenerated,
};
