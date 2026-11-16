const SECTION_NAMES = [
  'script',
  'logic',
  'render',
  'template',
  'component',
  'page',
  'module',
  'main',
];

const ROLE_NAMES = new Set(['component', 'page', 'module', 'main']);

function isTopLevel(source) {
  const { extractSections } = require('./javascript-language-service');
  const sections = extractSections(source, require('typescript'));
  const last = [...sections.values()].at(-1);
  if (last?.bodyEnd === source.length) return false;
  const remainder = source.slice(last ? last.bodyEnd + 1 : 0);
  // A partial declaration header is not a place for another top-level block.
  return !/@template\s+[$_\p{ID_Start}]/u.test(remainder);
}

function getAvailableSections(source) {
  const usedSections = new Set(
    [...source.matchAll(/^\s*@(script|logic|render|component|page|module|main)\b/gm)]
      .map((match) => match[1]),
  );
  const hasRole = SECTION_NAMES.some((name) => ROLE_NAMES.has(name) && usedSections.has(name));

  return SECTION_NAMES.filter((name) => (
    (name === 'template' || !usedSections.has(name)) && !(hasRole && ROLE_NAMES.has(name))
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
