'use client';

// The only module that imports Monaco, reached through `next/dynamic` (see editor-pane): it and
// its workers load from this app's own files, never a CDN. Only what a read-only viewer needs
// is imported, not `editor.main`, so no TypeScript, CSS or HTML language service is bundled.
import * as monaco from 'monaco-editor/editor/editor.api';
// The package's `exports` map has no entry for CSS, so the icon font's styles are named by path.
import '../../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import '../../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/yaml/register';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import { useEffect, useRef } from 'react';
import type { EditorLanguage } from './editor-model';

// The workers are bundled with the app: `new Worker(new URL(…, import.meta.url))` makes the
// bundler emit them as same-origin files. The JSON language service has one; its checks are off
// below, so it only has to exist.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new Worker(new URL('monaco-editor/language/json/json.worker.js', import.meta.url));
    }
    return new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url));
  },
};
jsonDefaults.setDiagnosticsOptions({ validate: false, schemaValidation: 'ignore' });
jsonDefaults.setModeConfiguration({ tokens: true });

const THEME_NAME = 'studio';

/** The design tokens (hex values only, as Monaco takes) of the current theme. */
function tokensOf(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    bg: read('--code-bg'),
    text: read('--text'),
    dim: read('--text-dim'),
    border: read('--border-hairline'),
    hover: read('--hover'),
    brand: read('--brand'),
    tint: read('--brand-tint'),
    mono: read('--font-mono') || 'monospace',
  };
}

/** `#rrggbb`-only: a token that is not (it should be) falls back to Monaco's own colour. */
const hex = (value: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value : undefined);

/** The theme the app has applied: next-themes sets the class on `<html>` after its own render. */
const isDark = () => !document.documentElement.classList.contains('light');

function defineStudioTheme(dark: boolean) {
  const tokens = tokensOf();
  const colors: Record<string, string> = {};
  const set = (key: string, value: string) => {
    const valid = hex(value);
    if (valid) colors[key] = valid;
  };
  set('editor.background', tokens.bg!);
  set('editor.foreground', tokens.text!);
  set('editorLineNumber.foreground', tokens.dim!);
  set('editorLineNumber.activeForeground', tokens.text!);
  set('editor.lineHighlightBackground', tokens.hover!);
  set('editor.selectionBackground', tokens.tint!);
  set('editorCursor.foreground', tokens.brand!);
  set('editorWidget.background', tokens.bg!);
  set('editorWidget.border', tokens.border!);
  set('editorGutter.background', tokens.bg!);
  monaco.editor.defineTheme(THEME_NAME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors,
  });
  return tokens.mono!;
}

export interface MonacoViewProps {
  value: string;
  language: EditorLanguage;
  /** Names the model and the editor for assistive technology. */
  path: string;
  /** A 1-based line to bring into view and put the cursor on. */
  revealLine?: number;
  /** Changes whenever the same line is asked for again. */
  revealToken?: number;
}

/** A read-only Monaco over one file's text: nothing is rendered as HTML, run or followed. */
export default function MonacoView({
  value,
  language,
  path,
  revealLine,
  revealToken,
}: MonacoViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // One editor for the view's life; the model and the theme change under it.
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const fontFamily = defineStudioTheme(isDark());
    const created = monaco.editor.create(element, {
      readOnly: true,
      domReadOnly: true,
      links: false,
      theme: THEME_NAME,
      fontFamily,
      fontSize: 12.5,
      lineHeight: 20,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      contextmenu: false,
      tabFocusMode: true,
      renderWhitespace: 'none',
      ariaLabel: `File ${path}`,
    });
    editor.current = created;
    return () => {
      const model = created.getModel();
      created.dispose();
      model?.dispose();
      editor.current = null;
    };
    // Created once; the effects below keep it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follows the class on `<html>` itself, so the tokens are read after the app has applied them.
  useEffect(() => {
    const apply = () => {
      const fontFamily = defineStudioTheme(isDark());
      monaco.editor.setTheme(THEME_NAME);
      editor.current?.updateOptions({ fontFamily });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const current = editor.current;
    if (!current) return undefined;
    const model = monaco.editor.createModel(value, language);
    const previous = current.getModel();
    current.setModel(model);
    current.updateOptions({ ariaLabel: `File ${path}` });
    previous?.dispose();
    return undefined;
  }, [value, language, path]);

  useEffect(() => {
    const current = editor.current;
    if (!current || revealLine === undefined) return;
    current.setPosition({ lineNumber: revealLine, column: 1 });
    current.revealLineInCenter(revealLine);
    current.focus();
  }, [revealLine, revealToken, value]);

  return <div ref={host} className="h-full min-h-80 w-full" data-testid="monaco-host" />;
}
