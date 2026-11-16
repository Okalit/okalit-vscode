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

The virtual class uses the same role mixin as the compiler: `AppMixin` for
`@main`, `PageMixin` for `@page`, `ModuleMixin` for `@module`, and the base
`Okalit` class for `@component`. Inherited APIs such as `switchLocale`,
`navigate`, and page route helpers are therefore available on the appropriate
roles. For older core releases whose mixin JSDoc incorrectly returns only the
base class, the editor infers the returned class instead. This adjustment is
in memory only; it does not modify installed packages or suppress diagnostics.
The same inference preserves `.value` on the core's signal wrappers, including
`getI18n().locale.value`, when an older annotation names only the upstream
signal class.

### Project aliases

Alias resolution reads the closest `tsconfig.json` or `jsconfig.json` for
each importing file, including `extends`, `baseUrl`, and `paths`. This also
applies to JavaScript modules imported by an `.ok` file. For example:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@core/*": ["src/core/*"],
      "@styles/*": ["src/styles/*"]
    }
  },
  "include": ["src/**/*"]
}
```

This enables imports such as
`import { GlobalConfigChannel } from '@core/channels/config.channel.js'`.
Keep these paths aligned with the aliases in your bundler configuration.
The extension does not execute Rsbuild configuration files to discover aliases.
Saving, creating, or deleting `jsconfig.json` or `tsconfig.json` refreshes open
`.ok` diagnostics; configuration errors are reported as editor notifications.
Reload the window after changing other files referenced through `extends`.
Resolving existing alias imports and suggesting their symbols is supported;
the separate file/folder path suggestions are still limited to relative paths.

Reactive properties declared in the role's `props` are included in the virtual
class used by IntelliSense. Both the named-object format and the legacy array
of prop definitions work with `@component`, `@page`, `@module` and `@main`.
For example, declaring `components: { type: Array, value: [] }` exposes
`this.components.value`, `.get()` and `.set()` inside `@logic`, and
go-to-definition returns to the prop declaration.

String, Number and Boolean props retain their corresponding value types;
Array, Object and Date constructors are also recognized. Arrays without an
element schema remain broadly typed, not a validated model of their contents.
Simple default values are used when no constructor is provided. Explicit
class members in `@logic` keep their existing JavaScript inference instead of
being replaced by generated declarations. Unknown properties and incompatible
typed assignments still produce diagnostics; this feature does not suppress
JavaScript errors globally.

### Channels

Named entries in the role's `channels: { ... }` object are exposed as instance
handles, including quoted names and shorthand entries, for all four roles.
For example, `configChannel: GlobalConfigChannel('_onConfigHandler')` enables
`this.configChannel.value`, `.set(value)` and `.reset()` in logic, render
expressions and reusable templates. Definition navigation returns to the
channel entry. Explicit instance members keep their own JavaScript inference.

The handle follows the core API: `value` is read-only; use `set` to change it.
Payloads currently remain broadly typed because the channel factory owns their
schema, not the role declaration. This does not infer completion for fields
inside `value` or validate payload shapes. Dynamically assembled channel maps
(such as spreads or imported objects instead of a literal map) are not expanded.
Unknown instance channel names and unknown handle methods still report errors.

HTML interpolation uses JavaScript scopes in both `@render` and `@template`,
including nested expressions, quoted attributes, and Lit event/property/boolean
bindings. Literal HTML attribute text retains string highlighting. Embedded
language metadata tells VS Code to treat the expressions as JavaScript; the
active theme still decides the exact colors.

After changing extension code, reload the Extension Development Host. An
already-installed Marketplace version will only get these changes after a
new extension release is installed.

Run the manifest and grammar checks with:

```sh
npm test
```

Highlighting integration tests tokenize the actual VS Code built-in HTML and
JavaScript grammars with TextMate/Oniguruma. On nonstandard installations set
`VSCODE_EXTENSIONS_PATH` to the editor's built-in `extensions` directory.
That integration test reports a skip when these external grammars are absent;
other extension tests do not require a VS Code installation.

## Reusable templates

Top-level `@template` declarations can repeat. A declaration without parentheses
generates a getter; a declaration with parentheses generates a method, even
when the parameter list is empty:

```okalit
@page {
  tag: 'example-home',
}

@template content {
  <h1>Welcome</h1>
}

@template greeting(name) {
  <p>Hello, ${name}</p>
}

@logic {
  chooseContent(show) {
    return show ? this.content : this.greeting('Ada');
  }
}

@render {
  ${this.chooseContent(true)}
}
```

The `@` completion list always offers `@template`, including after previous
template declarations. Names, parameters, template expressions, and render
expressions participate in JavaScript completion, hover, definitions,
references, signature help, and diagnostics. HTML is highlighted as HTML,
while `${...}` and parameters are highlighted as JavaScript. Put a template's
closing brace on its own line. Templates belong at the top level, not inside
`@logic`; keep control flow in normal JavaScript methods.

Use unique names that do not conflict with instance members in `@logic`.
`render` and `constructor` are reserved. Rendering still uses Lit, including
normal expressions and directives; raw `html`-returning methods remain valid.
This syntax also requires the updated `@okalit/engine` compiler in the project;
updating only the editor extension does not update the project's compiler.
