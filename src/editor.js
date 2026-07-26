// The mount-document editor pane: CodeMirror 6, ⌘↵ evaluates, Escape returns
// focus to the grid. Deliberately explicit-eval (never auto-compile): a
// half-typed definition must not go live mid-performance.

import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';

const theme = EditorView.theme(
  {
    '&': { backgroundColor: '#14151a', color: '#c8cdd6', fontSize: '13px', height: '100%' },
    '.cm-content': { fontFamily: '"SF Mono", Menlo, monospace', caretColor: '#ffffff' },
    '.cm-gutters': { backgroundColor: '#0e0f12', color: '#5a5f6a', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: '#ffffff' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(95, 143, 191, 0.3)',
    },
  },
  { dark: true },
);

export class MountEditor {
  // onEval(source) is called on ⌘↵; onExit() on Escape
  constructor(parent, { onEval, onExit, onChange } = {}) {
    this.onEval = onEval;
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          history(),
          javascript(),
          theme,
          keymap.of([
            {
              key: 'Mod-Enter',
              run: (view) => {
                onEval?.(view.state.doc.toString());
                return true; // consume: must not reach the global play/stop
              },
            },
            {
              key: 'Escape',
              run: () => {
                onExit?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange?.();
          }),
        ],
      }),
    });
  }

  getSource() {
    return this.view.state.doc.toString();
  }

  setSource(text) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  focus() {
    this.view.focus();
  }
}
