const {
  getAvailableSections,
  isTopLevel,
  parseRelativeImportPath,
} = require('./completion');
const { createLanguageService } = require('./javascript-language-service');

function activate(context) {
  const vscode = require('vscode');
  const javascriptProvider = createLanguageService(vscode, context);

  const provider = {
    resolveCompletionItem(item, token) {
      return javascriptProvider.resolveCompletionItem(item, token);
    },
    async provideCompletionItems(document, position) {
      const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
      const textBefore = document.getText(new vscode.Range(
        new vscode.Position(0, 0),
        position,
      ));
      const blockPrefix = linePrefix.match(/^([ \t]*)@([A-Za-z_-]*)$/);

      if (blockPrefix && isTopLevel(textBefore)) {
        const replaceRange = new vscode.Range(
          position.line,
          blockPrefix[1].length,
          position.line,
          position.character,
        );

        return getAvailableSections(textBefore).map((name) => {
          const item = new vscode.CompletionItem(
            `@${name}`,
            vscode.CompletionItemKind.Keyword,
          );
          item.insertText = `@${name}`;
          if (name === 'template') {
            item.insertText = new vscode.SnippetString('@template ${1:content} {\n  $0\n}');
            item.documentation = 'Reusable HTML fragment. Without parentheses: getter (this.content). With parentheses: method (this.content(...)).';
          }
          item.range = replaceRange;
          item.detail = ['component', 'page', 'module', 'main'].includes(name)
            ? 'Oakalit role block'
            : 'Oakalit optional block';
          return item;
        });
      }

      const importPath = parseRelativeImportPath(linePrefix);
      if (!importPath) return javascriptProvider.provideCompletionItems(document, position);

      const directory = vscode.Uri.joinPath(
        vscode.Uri.joinPath(document.uri, '..'),
        importPath.directory,
      );
      let entries;

      try {
        entries = await vscode.workspace.fs.readDirectory(directory);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return [];
        }
        throw error;
      }

      const replaceRange = new vscode.Range(
        position.line,
        importPath.valueStart + importPath.directory.length,
        position.line,
        position.character,
      );

      return entries
        .filter(([name]) => name.startsWith(importPath.basename))
        .map(([name, type]) => {
          const isDirectory = (type & vscode.FileType.Directory) !== 0;
          const item = new vscode.CompletionItem(
            name,
            isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
          );
          item.insertText = isDirectory ? `${name}/` : name;
          item.range = replaceRange;
          item.detail = isDirectory ? 'Folder' : 'Relative import';
          if (isDirectory) {
            item.command = {
              command: 'editor.action.triggerSuggest',
              title: 'Suggest files in folder',
            };
          }
          return item;
        });
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      'okalit',
      provider,
      '@',
      '.',
      '/',
      '"',
      "'",
    '(',
    ',',
    ' ',
    ),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
