# Okalit Language Support

Experimental Visual Studio Code language support for Okalit `.ok` files.
This extension provides TextMate syntax highlighting and basic editor behavior;
it does not compile files. It also suggests unused top-level section names
after `@` and relative file or folder paths inside JavaScript imports.
The Oakalit logo is used for the Marketplace extension icon and the `.ok`
language icon.

The grammar recognizes the current `@component`, `@page`, `@module`, and
`@main` role blocks; optional `@script`, `@logic`, and `@render` blocks; HTML
inside `@render`; JavaScript `${...}` expressions; and Lit-style `@event` and
`.property` attributes.

## Try it locally

1. Run `npm install` in this folder to install the TypeScript language service.
2. Open this folder in Visual Studio Code.
3. Press **F5** to launch an isolated Extension Development Host. The launch
   configuration disables other installed extensions there, while loading this
   development extension.
4. Open an `.ok` file, such as the experimental app template, and use
   **Developer: Inspect Editor Tokens and Scopes** to inspect its highlighting.

The extension uses standard TextMate scopes, so the active VS Code theme chooses
the colors. TypeScript is used as a JavaScript language-service dependency; the
extension itself is implemented in JavaScript.

Import path completion covers relative paths such as `./` and `../`. JavaScript
IntelliSense inside `@script` and `@logic` is powered by the TypeScript
JavaScript language service. `@script` is treated as module scope, and `@logic`
as class members. IntelliSense includes symbol completion, hover information,
go-to-definition, find references, signature help, and mapped JavaScript
diagnostics for those blocks.

Run the manifest and grammar checks with:

```sh
npm test
```
