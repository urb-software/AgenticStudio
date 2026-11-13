import { describe, expect, it } from 'vitest';
import { colourViolationsInFile, designSystemViolationsInFile } from './styling-rules';

// Per-case checks of the styling source rules; the gate fixtures in web.test.ts prove the
// rules are wired into architecture:web.
const rulesIn = (violations: { rule: string }[]) => [...new Set(violations.map((v) => v.rule))];

describe('web-no-colour-literals', () => {
  it.each([
    ['whole-string hex', 'page.tsx', `const brand = '#7C3AED';`],
    ['3-digit hex', 'page.tsx', `const c = '#fff';`],
    ['4-digit hex', 'page.tsx', `const c = '#fffa';`],
    ['8-digit hex', 'page.tsx', `const c = '#7c3aed80';`],
    ['arbitrary class value', 'page.tsx', `<div className="bg-[#7c3aed] p-4" />`],
    ['arbitrary shadow value', 'page.tsx', 'const c = `shadow-[0_0_0_1px_#ABCDEF]`;'],
    ['CSS-like declaration in a string', 'page.tsx', `const c = 'color: #abc';`],
    ['space-separated hex with letters', 'page.tsx', `const c = '1px solid #e4e4e7';`],
    ['hex in a template middle', 'page.tsx', 'const c = `${a} #fff ${b}`;'],
    ['gradient argument', 'page.tsx', `const c = 'linear-gradient(#fff, #000)';`],
    ['rgb()', 'page.tsx', `const c = 'rgb(0 0 0 / 50%)';`],
    ['hsla()', 'page.tsx', `const c = 'hsla(0, 0%, 0%, 0.5)';`],
    ['oklch() in a class', 'page.tsx', `<div className="bg-[oklch(0.7_0.1_200)]" />`],
    ['color() with a colour space', 'page.tsx', `const c = 'color(display-p3 1 0 0)';`],
    ['hex in a CSS declaration', 'card.css', `.card { color: #fff; }`],
    ['hex in a nested CSS declaration', 'card.css', `.card { &:hover { border-color: #ABC } }`],
    ['rgba() in CSS', 'card.css', `.card { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }`],
    ['hex in @apply', 'card.css', `.card { @apply bg-[#fff]; }`],
    ['hex in SCSS', 'card.scss', `$x: 1; .card { color: #fff; }`],
    ['hex in Sass', 'card.sass', `.card\n  color: #fff\n`],
  ])('fails on %s', (_name, path, text) => {
    expect(rulesIn(colourViolationsInFile(path, text))).toEqual(['web-no-colour-literals']);
  });

  it.each([
    ['an Issue or PR reference', 'page.tsx', `const t = 'PR #1234 and Refs #123';`],
    ['a selector argument', 'page.tsx', `document.querySelector('#feed');`],
    ['a closest() selector', 'page.tsx', `el.closest('#add');`],
    ['a URL fragment', 'page.tsx', `const u = '/docs/#abc';`],
    ['an anchor in a string href', 'page.tsx', `<a href="#feed">Feed</a>`],
    ['an anchor in an expression href', 'page.tsx', `<a href={'#feed'}>Feed</a>`],
    ['an anchor in a template href', 'page.tsx', '<a href={`#add`}>Add</a>'],
    ['prose mentioning color()', 'page.tsx', `const t = 'pick a color(optional)';`],
    ['an HTML entity', 'page.tsx', `const t = '&#123;';`],
    ['a comment', 'page.tsx', `// #fff\nconst x = 1;`],
    [
      'color-mix() over tokens',
      'card.css',
      `.a { color: color-mix(in oklab, var(--brand) 50%, transparent); }`,
    ],
    ['a CSS id selector', 'card.css', `#add { padding: 0; }\n.list #feed > a { margin: 0; }`],
    ['a CSS comment', 'card.css', `/* #fff */ .a { color: var(--text); }`],
    ['a SCSS id selector and line comment', 'card.scss', `// #fff\n#add { padding: 0; }`],
    ['a media query', 'card.css', `@media (min-width: 768px) { #add { padding: 0; } }`],
  ])('allows %s', (_name, path, text) => {
    expect(colourViolationsInFile(path, text)).toEqual([]);
  });
});

describe('web-no-style-colours', () => {
  it.each([
    ['a colour-named key', `<div style={{ backgroundColor: tone }} />`],
    ['a kebab-case colour key', `<div style={{ 'border-color': tone }} />`],
    ['a custom colour property', `<div style={{ '--brand-color': tone }} />`],
    ['a filter (may carry a colour)', `<div style={{ filter: shadow }} />`],
    ['a border image', `<div style={{ borderImage: image }} />`],
    ['a mask', `<div style={{ mask: m }} />`],
    ['a named colour in any value', `<div style={{ gridArea: 'red' }} />`],
    ['a colour function in any value', `<div style={{ translate: 'rgb(0 0 0)' }} />`],
    ['a non-literal style', `<div style={styles} />`],
    ['a spread', `<div style={{ ...base }} />`],
    ['a computed key', `<div style={{ [key]: 1 }} />`],
    ['a declaration string', `<div style="color: red" />`],
  ])('fails on %s', (_name, text) => {
    expect(rulesIn(colourViolationsInFile('page.tsx', text))).toContain('web-no-style-colours');
  });

  it.each([
    ['layout values', `<div style={{ width: 240, height: '50%' }} />`],
    ['a layout custom property', `<div style={{ '--rail': '16rem', width: 'var(--rail)' }} />`],
    ['a non-colour variable', `<div style={{ width: w, gridArea: 'main' }} />`],
  ])('allows %s', (_name, text) => {
    expect(colourViolationsInFile('page.tsx', text)).toEqual([]);
  });
});

describe('web-no-design-system-imports', () => {
  it.each([
    ['a relative import', 'src/app/page.tsx', `import x from '../../design-system/code/x';`],
    ['a re-export', 'src/index.ts', `export * from '../design-system/x';`],
    ['a dynamic import', 'src/a.ts', `await import('../../design-system/x');`],
    ['a concatenated import()', 'src/a.ts', `await import('../../' + 'design-system/x');`],
    ['a split concatenation', 'src/a.ts', `require('../../design-' + 'system/x');`],
    ['a template require()', 'src/a.ts', 'require(`${root}/design-system/x`);'],
    ['require.resolve()', 'src/a.ts', `require.resolve('../design-system/x');`],
    ['a CSS @import', 'src/app/a.css', `@import '../../design-system/code/globals.css';`],
    ['a Tailwind @source', 'src/app/a.css', `@source "../../design-system";`],
    ['a SCSS @use', 'src/app/a.scss', `@use '../../design-system/x';`],
    ['a url()', 'src/app/a.css', `.a { background: url(../../design-system/x.png); }`],
    ['a tsconfig alias', 'tsconfig.json', `{ "paths": { "@ds/*": ["../../design-system/*"] } }`],
    ['a jsconfig alias', 'jsconfig.json', `{ "paths": { "@ds/*": ["../../design-system/*"] } }`],
    [
      'a package.json entry',
      'package.json',
      `{ "dependencies": { "x": "link:../../design-system" } }`,
    ],
    [
      'shadcn components.json',
      'components.json',
      `{ "tailwind": { "css": "../../design-system/code/globals.css" } }`,
    ],
    [
      'a next.config alias',
      'next.config.ts',
      `export default { turbopack: { resolveAlias: { '@ds': '../../design-system' } } };`,
    ],
    [
      'a concatenated next.config alias',
      'next.config.mjs',
      `const ds = path.join(root, '..', '..', 'design-' + 'system');`,
    ],
    [
      'a postcss.config path',
      'postcss.config.mjs',
      `export default { from: '../../design-system/x' };`,
    ],
  ])('fails on %s', (_name, path, text) => {
    expect(rulesIn(designSystemViolationsInFile(path, text))).toEqual([
      'web-no-design-system-imports',
    ]);
  });

  it.each([
    ['an unrelated import', 'src/app/page.tsx', `import x from '@/shared/ui/button';`],
    [
      'prose mentioning the design system',
      'src/app/page.tsx',
      `const t = 'design-system/ is a reference';`,
    ],
    [
      'a components.json to the app copy',
      'components.json',
      `{ "tailwind": { "css": "src/app/globals.css" } }`,
    ],
    ['a next.config without aliases', 'next.config.ts', `export default { agentRules: false };`],
  ])('allows %s', (_name, path, text) => {
    expect(designSystemViolationsInFile(path, text)).toEqual([]);
  });
});
