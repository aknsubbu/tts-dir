import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';

/**
 * script.txt's own small mode: [block] lines, <mark name="x"/> tags and # comments stand out,
 * and each block line says how many words follow and, once checked, how long they take to say.
 */
const scriptLanguage = StreamLanguage.define({
  name: 'narration',
  token(stream) {
    if (stream.sol() && stream.match(/^\s*#.*/)) return 'comment';
    if (stream.sol() && stream.match(/^\s*\[[A-Za-z0-9_-]+\]\s*$/)) return 'heading';
    if (stream.match(/<mark\s+name\s*=\s*["'][A-Za-z0-9_-]+["']\s*\/>/)) return 'keyword';
    stream.next();
    return null;
  },
});

class BlockInfo extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-block-info';
    span.textContent = this.text;
    return span;
  }
}

const setDurations = StateEffect.define();
const durations = StateField.define({
  create: () => ({}),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setDurations) ? e.value : v), value),
});

/** After each [block] line: "28 words · 9.1 s", or "not spoken yet" until a check speaks it. */
const blockInfo = StateField.define({
  create: (state) => decorateBlocks(state),
  update: (deco, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setDurations)) ? decorateBlocks(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

function decorateBlocks(state) {
  const builder = new RangeSetBuilder();
  const spoken = state.field(durations, false) || {};
  const doc = state.doc;
  let open = null;
  let words = 0;
  const close = () => {
    if (!open) return;
    const secs = spoken[open.id];
    builder.add(open.end, open.end, Decoration.widget({ widget: new BlockInfo(`${words} word${words === 1 ? '' : 's'} · ${secs ? `${secs.toFixed(1)} s` : 'not spoken yet'}`), side: 1 }));
  };
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (/^\s*#/.test(line.text)) continue;
    const m = /^\s*\[([A-Za-z0-9_-]+)\]\s*$/.exec(line.text);
    if (m) {
      close();
      open = { id: m[1], end: line.to };
      words = 0;
    } else if (open) {
      words += line.text.replace(/<mark[^>]*\/>/g, '').split(/\s+/).filter(Boolean).length;
    }
  }
  close();
  return builder.finish();
}

// Colours from the page's own palette, so the editor follows light and dark mode.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--accent)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--ok)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--warn)' },
  { tag: [t.comment, t.lineComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.definition(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.className)], fontWeight: '600' },
  { tag: t.heading, color: 'var(--accent)', fontWeight: '700' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--panel)', color: 'var(--text)', fontSize: '13px', height: '100%' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)' },
  '.cm-block-info': { marginLeft: '12px', color: 'var(--muted)', fontSize: '11.5px', fontFamily: 'system-ui, sans-serif' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
});

/** Problems from a check, as editor diagnostics on their lines. */
export function toDiagnostics(doc, problems) {
  const out = [];
  for (const p of problems) {
    if (!p.line || p.line < 1 || p.line > doc.lines) continue;
    const line = doc.line(p.line);
    out.push({ from: line.from, to: Math.max(line.from, line.to), severity: p.severity, message: p.message.replace(/^line \d+: /, '') });
  }
  return out;
}

/**
 * A CodeMirror 6 editor for one file. `language` is 'python' or 'script'. The text is the
 * editor's own while you type; a new `value` from outside (a reload, a discard) replaces it.
 * ⌘S (Ctrl+S) calls onSave. `problems` are [{ line, message, severity }] for this file.
 */
export default function CodeEditor({ value, onChange, language, problems = [], durations: spokenFor = null, readOnly = false, onSave, label, viewRef }) {
  const host = useRef(null);
  const view = useRef(null);
  const editable = useRef(new Compartment());
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave?.(), true) }])),
          basicSetup,
          language === 'python' ? python() : [scriptLanguage, durations, blockInfo],
          syntaxHighlighting(highlight),
          lintGutter(),
          theme,
          EditorView.lineWrapping,
          editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => u.docChanged && handlers.current.onChange?.(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    if (viewRef) viewRef.current = v;
    return () => v.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A value from outside replaces the text, but typing never comes back round as one.
  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch(setDiagnostics(v.state, toDiagnostics(v.state.doc, problems)));
  }, [problems, value]);

  useEffect(() => {
    if (spokenFor && language !== 'python') view.current?.dispatch({ effects: setDurations.of(spokenFor) });
  }, [spokenFor, language]);

  return <div className="code-editor" ref={host} />;
}

/** Put the cursor on a line and scroll it into view. */
export function goToLine(v, line) {
  if (!v || !line || line > v.state.doc.lines) return;
  const at = v.state.doc.line(line).from;
  v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
  v.focus();
}
