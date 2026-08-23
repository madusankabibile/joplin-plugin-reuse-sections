// CodeMirror 6 content script.
//
// Three jobs, in order of how often they matter:
//
//   * typing `&&&/` opens a drop-down of notebooks, then notes, then sections,
//     one level per `/`, filtering as you type;
//   * `&&&` fences and `&&&/` references are coloured while editing;
//   * the two editor commands the main script calls into.

import {
	Completion,
	CompletionContext,
	CompletionResult,
	autocompletion,
	startCompletion,
} from '@codemirror/autocomplete';
import { Decoration, DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { isCloseFence, lastSegmentStart, parseOpenFence, parseRefLine } from '../reuse/syntax';
import { CompletionOption, CompletionReply } from '../reuse/types';

const MAX_HIGHLIGHTED_LINES = 50000;

/** What the user types to summon the picker. */
const TRIGGER = '&&&/';

const markerMark = Decoration.mark({ class: 'cm-rsx-marker' });
const idMark = Decoration.mark({ class: 'cm-rsx-id' });
const labelMark = Decoration.mark({ class: 'cm-rsx-label' });
const targetMark = Decoration.mark({ class: 'cm-rsx-target' });
const sectionMark = Decoration.mark({ class: 'cm-rsx-section-name' });

const lineDecorationCache: Record<string, Decoration> = {};
const lineDecoration = (classes: string): Decoration => {
	if (!lineDecorationCache[classes]) {
		lineDecorationCache[classes] = Decoration.line({ class: classes });
	}
	return lineDecorationCache[classes];
};

const buildDecorations = (state: EditorState): DecorationSet => {
	const builder = new RangeSetBuilder<Decoration>();
	if (state.doc.lines > MAX_HIGHLIGHTED_LINES) return builder.finish();

	let depth = 0;

	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
		const line = state.doc.line(lineNumber);
		const text = line.text;

		const reference = parseRefLine(text);
		if (reference) {
			builder.add(line.from, line.from, lineDecoration('cm-rsx-line cm-rsx-ref'));
			builder.add(line.from + reference.markerStart, line.from + reference.markerEnd, markerMark);

			if (line.to > line.from + reference.bodyStart) {
				// The `#section` part is coloured apart from the note path, so
				// a reference reads as "which note" then "which part of it".
				const hash = text.lastIndexOf('/#');
				const bodyEnd = hash > reference.bodyStart ? line.from + hash : line.to;
				builder.add(line.from + reference.bodyStart, bodyEnd, targetMark);
				if (bodyEnd < line.to) builder.add(bodyEnd, line.to, sectionMark);
			}
			continue;
		}

		const open = parseOpenFence(text);
		if (open) {
			depth += 1;
			builder.add(line.from, line.from, lineDecoration(
				`cm-rsx-line cm-rsx-fence cm-rsx-fence-open cm-rsx-depth-${Math.min(depth, 4)}`,
			));
			builder.add(line.from + open.markerStart, line.from + open.markerEnd, markerMark);
			if (open.id) builder.add(line.from + open.idStart, line.from + open.idEnd, idMark);
			if (open.label) builder.add(line.from + open.labelStart, line.to, labelMark);
			continue;
		}

		if (isCloseFence(text) && depth > 0) {
			builder.add(line.from, line.from, lineDecoration(
				`cm-rsx-line cm-rsx-fence cm-rsx-fence-close cm-rsx-depth-${Math.min(depth, 4)}`,
			));
			if (line.to > line.from) builder.add(line.from, line.to, markerMark);
			depth -= 1;
			continue;
		}

		if (depth > 0) {
			builder.add(line.from, line.from, lineDecoration(
				`cm-rsx-line cm-rsx-body cm-rsx-depth-${Math.min(depth, 4)}`,
			));
		}
	}

	return builder.finish();
};

const highlightField = StateField.define<DecorationSet>({
	create: state => buildDecorations(state),
	update: (decorations, transaction) =>
		transaction.docChanged ? buildDecorations(transaction.state) : decorations,
	provide: field => EditorView.decorations.from(field),
});

/** Replaces `[from, to)` with `text` and leaves the caret after it. */
const replaceRange = (view: EditorView, from: number, to: number, text: string) => {
	view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + text.length },
		scrollIntoView: true,
	});
	view.focus();
};

export default (context: { contentScriptId: string; postMessage: (message: any)=> Promise<any> }) => {
	return {
		plugin: async (editorControl: any) => {
			// Decorations and the type-ahead trigger are CodeMirror 6 only. On
			// the legacy editor we keep the commands and skip the rest, rather
			// than throwing and losing them as well.
			const isCodeMirror6 = typeof editorControl.addExtension === 'function';

			let settings = { editorHighlighting: true, suggestAsYouType: true };
			try {
				const loaded = await context.postMessage({ type: 'settings' });
				if (loaded) settings = { ...settings, ...loaded };
			} catch (_error) {
				// Older Joplin, or the plugin is not listening yet: use the
				// defaults, which are what most people would have chosen.
			}

			if (isCodeMirror6 && settings.editorHighlighting) {
				editorControl.addExtension(highlightField);
			}

			// -----------------------------------------------------------------
			// Typing `&&&/` opens the drop-down
			// -----------------------------------------------------------------

			// What is offered depends on what has been typed so far, and only
			// the plugin can answer that - it is the side with the notebooks.
			// The reply is cached against the part of the reference before the
			// segment being typed, so filtering never costs a round trip.
			let cacheKey: string | null = null;
			let cached: Promise<CompletionReply> | null = null;

			const optionsFor = (rest: string): Promise<CompletionReply> => {
				const key = rest.slice(0, lastSegmentStart(rest));
				if (cacheKey !== key || !cached) {
					cacheKey = key;
					cached = context.postMessage({ type: 'complete', rest });
				}
				return cached;
			};

			const toCompletion = (option: CompletionOption): Completion => ({
				label: option.label,
				detail: option.detail,
				boost: option.boost,
				apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
					view.dispatch({
						changes: { from, to, insert: option.insert },
						selection: { anchor: from + option.insert.length },
						scrollIntoView: true,
					});

					// A notebook is never the end of a reference, so the next
					// list opens straight away rather than waiting for a key.
					if (option.continues) setTimeout(() => startCompletion(view), 0);
				},
			});

			const completeReference = async (
				completionContext: CompletionContext,
			): Promise<CompletionResult | null> => {
				const line = completionContext.state.doc.lineAt(completionContext.pos);
				const before = line.text.slice(0, completionContext.pos - line.from);

				// The reference has to start the line or follow a space, which
				// is the same rule the viewer and the highlighting use.
				const match = /(?:^|\s)&&&\/(.*)$/.exec(before);
				if (!match) return null;

				let reply: CompletionReply;
				try {
					reply = await optionsFor(match[1]);
				} catch (_error) {
					return null;
				}
				if (!reply || !reply.options || !reply.options.length) return null;

				return {
					from: completionContext.pos - reply.from,
					options: reply.options.map(toCompletion),
					// Typing on within this segment filters what is already
					// here; a `/` starts a new level and asks again.
					validFor: /^[^/]*$/,
				};
			};

			if (isCodeMirror6 && settings.suggestAsYouType) {
				editorControl.addExtension([
					autocompletion(),
					// Registered as language data rather than as an override,
					// so Joplin's own completions are left alone.
					EditorState.languageData.of(() => [{ autocomplete: completeReference }]),
					// `activateOnTyping` reacts to words, and `&&&/` is not one,
					// so the first list is opened by hand.
					EditorView.updateListener.of((update: ViewUpdate) => {
						if (!update.docChanged) return;

						const head = update.state.selection.main.head;
						const line = update.state.doc.lineAt(head);
						if (!/(?:^|\s)&&&\/$/.test(line.text.slice(0, head - line.from))) return;

						let justTyped = false;
						update.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
							if (toB === head && inserted.length) justTyped = true;
						});
						if (!justTyped) return;

						setTimeout(() => startCompletion(update.view), 0);
					}),
				]);
			}

			// -----------------------------------------------------------------
			// Commands, called from the main script with editor.execCommand
			// -----------------------------------------------------------------

			editorControl.registerCommand('reuseSections.insertReference', (reference: string) => {
				if (!reference) return;

				const view: EditorView = editorControl.editor;
				const range = view.state.selection.main;
				const line = view.state.doc.lineAt(range.from);
				const before = view.state.sliceDoc(line.from, range.from);

				// Reuse a trigger the user has already typed, so picking from
				// the menu after typing `&&&/` does not leave it behind.
				const trigger = before.endsWith(TRIGGER) ? TRIGGER.length : 0;
				const prefix = !trigger && range.from > line.from && before.trim() ? '\n' : '';

				replaceRange(view, range.from - trigger, range.to, prefix + reference);
			});

			editorControl.registerCommand('reuseSections.markSection', (id: string) => {
				const view: EditorView = editorControl.editor;
				const state = view.state;
				const range = state.selection.main;

				// Whole lines, so a fence never lands mid-sentence.
				const from = state.doc.lineAt(range.from).from;
				const to = state.doc.lineAt(range.to).to;
				const selected = state.sliceDoc(from, to);
				const name = (id || '').trim();

				const open = name ? `&&& ${name}` : '&&& ';
				const body = selected.trim() ? selected : 'Content to share';
				const text = `${open}\n${body}\n/&&&`;

				view.dispatch({
					changes: { from, to, insert: text },
					// With something to wrap, the caret waits where the section
					// name goes; with nothing to wrap, the placeholder body is
					// selected instead, so typing replaces it.
					selection: selected.trim()
						? { anchor: from + open.length }
						: { anchor: from + open.length + 1, head: from + open.length + 1 + body.length },
					scrollIntoView: true,
				});
				view.focus();
			});
		},

		assets: () => [{ name: './style.css' }],
	};
};
