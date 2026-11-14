const SECTION_NAMES = [
  'script',
  'logic',
  'render',
  'component',
  'page',
  'module',
  'main',
];

const ROLE_NAMES = new Set(['component', 'page', 'module', 'main']);

function isTopLevel(source) {
  let openIndent = null;

  for (const line of source.split(/\r?\n/)) {
    if (openIndent !== null) {
      if (new RegExp(`^${openIndent}\\}\\s*$`).test(line)) {
        openIndent = null;
      }
      continue;
    }

    const section = line.match(/^([ \t]*)@(script|logic|render|component|page|module|main)\b.*\{/);
    if (section) openIndent = section[1];
  }

  return openIndent === null;
}

function getAvailableSections(source) {
  const usedSections = new Set(
    [...source.matchAll(/^\s*@(script|logic|render|component|page|module|main)\b/gm)]
      .map((match) => match[1]),
  );
  const hasRole = SECTION_NAMES.some((name) => ROLE_NAMES.has(name) && usedSections.has(name));

  return SECTION_NAMES.filter((name) => (
    !usedSections.has(name) && !(hasRole && ROLE_NAMES.has(name))
  ));
}

function parseRelativeImportPath(linePrefix) {
  const match = linePrefix.match(/\b(?:from\s*|import\s*)['"]([^'"]*)$/);
  if (!match) return null;

  const value = match[1];
  if (!value.startsWith('./') && !value.startsWith('../') && value !== '.') return null;

  const slash = value.lastIndexOf('/');
  const directory = slash === -1 ? '.' : value.slice(0, slash + 1);
  const basename = slash === -1 ? value : value.slice(slash + 1);
  const valueStart = match.index + match[0].length - value.length;

  return { directory, basename, valueStart };
}

module.exports = {
  getAvailableSections,
  isTopLevel,
  parseRelativeImportPath,
};
