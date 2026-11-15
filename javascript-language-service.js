const path = require('node:path');

const SECTION_NAMES = new Set([
  'script',
  'logic',
  'render',
  'component',
  'page',
  'module',
  'main',
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

function findCodeSectionEnd(source, openIndex, ts) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source.slice(openIndex),
  );
  let depth = 0;

  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return source.length;
    if (token === ts.SyntaxKind.OpenBraceToken) depth++;
    if (token === ts.SyntaxKind.CloseBraceToken && --depth === 0) {
      return openIndex + scanner.getTokenPos();
    }
  }
}

function findRenderSectionEnd(source, openIndex) {
  let lineStart = source.indexOf('\n', openIndex);
  if (lineStart === -1) return source.length;
  lineStart++;

  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    if (source.slice(lineStart, lineEnd).trim() === '}') return lineStart + source.slice(lineStart, lineEnd).indexOf('}');
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return source.length;
}

function extractSections(source, ts) {
  const sections = new Map();
  let cursor = 0;

  while ((cursor = skipWhitespaceAndComments(source, cursor)) < source.length) {
    const marker = source.slice(cursor).match(/^@([A-Za-z][A-Za-z0-9_-]*)/);
    if (!marker || !SECTION_NAMES.has(marker[1])) break;

    let openIndex = cursor + marker[0].length;
    while (/\s/.test(source[openIndex] || '')) openIndex++;
    if (source[openIndex] !== '{') break;

    const end = marker[1] === 'render'
      ? findRenderSectionEnd(source, openIndex)
      : findCodeSectionEnd(source, openIndex, ts);
    if (!sections.has(marker[1])) {
      sections.set(marker[1], {
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

  append("import { Okalit as __Oakalit } from '@okalit/core';\n");
  if (sections.has('script')) append(sections.get('script').body, 'script');
  append('\nconst __okalitConfig = {};\nclass __OakalitIntellisense extends __Oakalit {\n');
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

function createLanguageService(vscode, context) {
  const ts = require('typescript');
  const documents = new Map();
  const virtualDocuments = new Map();
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ts.sys.getCurrentDirectory();
  const originalFileName = (fileName) => fileName.endsWith('.okalit.virtual.js')
    ? `${fileName.slice(0, -'.okalit.virtual.js'.length)}.ok`
    : path.resolve(fileName);
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

  const host = {
    getCompilationSettings: () => ({
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
    }),
    getCurrentDirectory: () => rootPath,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getScriptFileNames: () => [...documents.keys()].map((fileName) => getVirtualDocument(fileName).fileName),
    getScriptVersion: (fileName) => String(documents.get(originalFileName(path.resolve(fileName)))?.version ?? 0),
    getScriptKind: () => ts.ScriptKind.JS,
    getScriptSnapshot: (fileName) => {
      const normalized = path.resolve(fileName);
      if (normalized.endsWith('.okalit.virtual.js')) {
        const virtualDocument = getVirtualDocument(normalized);
        return virtualDocument ? ts.ScriptSnapshot.fromString(virtualDocument.code) : undefined;
      }

      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
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
  };
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
      const start = ts.getLineAndCharacterOfPosition(source, textSpan.start);
      const end = ts.getLineAndCharacterOfPosition(source, textSpan.start + textSpan.length);
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
  createLanguageService,
  createVirtualDocument,
  extractSections,
  generatedSpanToSource,
  sourceOffsetToGenerated,
};
