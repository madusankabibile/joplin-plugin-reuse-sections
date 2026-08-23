import joplin from 'api';
import {
	ContentScriptType,
	MenuItemLocation,
	SettingItemType,
	ToastType,
	ToolbarButtonLocation,
} from 'api/types';
import { formatReference, parseRefLine, parseReference } from './reuse/syntax';
import { EmbedCache, parseCache, serialiseCache } from './reuse/cache';
import { embedClasses, embedColour, embedHtml } from './reuse/render';
import { NoteEntry, PickResult } from './reuse/types';
import {
	clearEmbedCache,
	clearFolderCache,
	completeReference,
	currentRevision,
	listFolders,
	listNotesInFolder,
	listRecentNotes,
	listSections,
	notesChanged,
	resolveEmbed,
	resolveSource,
	setResolveOptions,
} from './reuse/resolve';
import { RECENT_ID, folderStepHtml, noteStepHtml, sectionStepHtml } from './picker';

const MARKDOWN_IT_SCRIPT_ID = 'com.madusanka.reuseSections.markdownIt';
const CODE_MIRROR_SCRIPT_ID = 'com.madusanka.reuseSections.codeMirror';

const INSERT_COMMAND = 'reuseSections.insert';
const MARK_COMMAND = 'reuseSections.mark';
const COPY_COMMAND = 'reuseSections.copy';
const REFRESH_COMMAND = 'reuseSections.refresh';

/** How many notes "recently edited" offers as a shortcut past the notebooks. */
const RECENT_LIMIT = 60;

/** Where the markdown behind the references in view is kept for the renderer. */
const CACHE_SETTING = 'embedCache';

const setting = async (key: string): Promise<any> => {
	try {
		return await joplin.settings.value(key);
	} catch (_error) {
		return undefined;
	}
};

/** Whether new references are written as a path or pinned to a note id. */
const buildReference = async (note: NoteEntry, section: string): Promise<string> => {
	const style = await setting('referenceStyle');

	return style === 'id'
		? formatReference({ noteId: note.id, section })
		: formatReference({ folderPath: note.folderPath, noteTitle: note.title, section });
};

joplin.plugins.register({
	onStart: async () => {
		// -------------------------------------------------------------
		// Settings
		// -------------------------------------------------------------
		await joplin.settings.registerSection('reuseSections', {
			label: 'Reuse Sections',
			iconName: 'fas fa-recycle',
		});

		await joplin.settings.registerSettings({
			showEmbedHeader: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Show where reused content comes from',
				description: 'Draws the source note and section above the content.',
			},
			embedColour: {
				value: 'violet',
				type: SettingItemType.String,
				section: 'reuseSections',
				public: true,
				isEnum: true,
				options: {
					violet: 'Violet',
					blue: 'Blue',
					teal: 'Teal',
					green: 'Green',
					amber: 'Amber',
					red: 'Red',
					grey: 'Grey',
					outline: 'No background, outline only',
					none: 'No box at all',
				},
				label: 'Colour around reused content',
				description: 'The tint and rule drawn around content borrowed from another note.',
			},
			showSectionMarkers: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Outline shareable sections in the viewer',
				description: 'Marks the parts of a note that other notes can reuse.',
			},
			liveUpdate: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Fill in new references without waiting',
				description: 'The first time a reference is used, show its content straight away rather than when the note is next drawn.',
			},
			expandNested: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Follow references inside reused content',
				description: 'A section that reuses another section brings it along, up to three levels deep.',
			},
			searchAnywhere: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Find notes that have moved',
				description: 'When the notebook in a reference no longer matches, look for the note by title instead.',
			},
			referenceStyle: {
				value: 'path',
				type: SettingItemType.String,
				section: 'reuseSections',
				public: true,
				isEnum: true,
				options: {
					path: 'Readable: &&&/notebook/note/#section',
					id: 'Stable: &&&/id/<note id>/#section',
				},
				label: 'How new references are written',
				description: 'Readable references survive nothing but read well; id references survive renames and moves.',
			},
			suggestAsYouType: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Suggest notebooks, notes and sections as you type &&&/',
				description: 'Reopen the note for a change to take effect.',
			},
			editorHighlighting: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Highlight sections and references in the markdown editor',
				description: 'Reopen the note for a change to take effect.',
			},
			showToolbarButton: {
				value: true,
				type: SettingItemType.Bool,
				section: 'reuseSections',
				public: true,
				label: 'Show the toolbar button',
				description: 'Restart Joplin for a change to take effect.',
			},
			[CACHE_SETTING]: {
				value: '',
				type: SettingItemType.String,
				section: 'reuseSections',
				public: false,
				label: 'Reused content, ready for the renderer',
			},
		});

		// -------------------------------------------------------------
		// The cache the viewer reads
		// -------------------------------------------------------------
		// A markdown-it rule cannot read another note, but Joplin does let a
		// content script read its own plugin's settings synchronously. So the
		// markdown behind every reference in view is kept in a setting, and the
		// rule tokenizes it into the note that borrows it - which is what makes
		// the other markdown-it plugins apply to it.
		let cache: EmbedCache = parseCache(String((await setting(CACHE_SETTING)) || ''));
		let saving: any = null;

		const saveCache = () => {
			if (saving) clearTimeout(saving);
			// Resolving a note's references is a burst of small updates; the
			// setting is written once at the end of it.
			saving = setTimeout(() => {
				saving = null;
				joplin.settings.setValue(CACHE_SETTING, serialiseCache(cache)).catch(() => {});
			}, 250);
		};

		/** Resolves `raw` and keeps it, unless an identical entry is already there. */
		const remember = async (raw: string, force = false): Promise<boolean> => {
			if (!force && cache[raw]) return false;

			const parsed = parseReference(raw);
			if (!parsed) return false;

			const resolved = await resolveSource(parsed);
			const before = cache[raw] ? JSON.stringify(cache[raw]) : '';
			if (before === JSON.stringify(resolved)) return false;

			// Re-inserted at the end, so the oldest entries are the ones
			// dropped when the cache is trimmed.
			delete cache[raw];
			cache[raw] = resolved;
			return true;
		};

		/** Every reference in a note, resolved and kept for the next render. */
		const rememberNote = async (noteId: string) => {
			if (!noteId) return;

			try {
				const note = await joplin.data.get(['notes', noteId], { fields: ['id', 'body'] });
				let changed = false;

				for (const line of String(note.body || '').split(/\r?\n/)) {
					const reference = parseRefLine(line);
					if (reference && await remember(reference.raw)) changed = true;
				}

				if (changed) saveCache();
			} catch (_error) {
				// The note has just been deleted, most likely.
			}
		};

		/** Re-resolves what a changed note is used for. */
		const refreshFor = async (noteId: string) => {
			let changed = false;

			for (const raw of Object.keys(cache)) {
				const entry = cache[raw];
				// Failed entries are retried as well: the note a reference is
				// waiting for may be the one that has just been created.
				if (entry.noteId !== noteId && !entry.error) continue;
				if (await remember(raw, true)) changed = true;
			}

			if (changed) saveCache();
		};

		const applySettings = async () => {
			setResolveOptions({
				searchAnywhere: (await setting('searchAnywhere')) !== false,
				expandNested: (await setting('expandNested')) !== false,
			});
		};

		await applySettings();
		await joplin.settings.onChange(async ({ keys }: any) => {
			// Writing the cache is a setting change of its own; reacting to it
			// would resolve everything again on every write.
			if (keys && keys.length === 1 && keys[0] === CACHE_SETTING) return;
			await applySettings();
		});

		// -------------------------------------------------------------
		// The picker
		// -------------------------------------------------------------
		const dialog = await joplin.views.dialogs.create('reuseSectionsPicker');
		await joplin.views.dialogs.addScript(dialog, './dialog/dialog.css');
		await joplin.views.dialogs.addScript(dialog, './dialog/dialog.js');

		const openStep = async (html: string, next: string, back: boolean): Promise<{
			action: 'next' | 'back' | 'cancel';
			choice: string;
		}> => {
			await joplin.views.dialogs.setHtml(dialog, html);
			await joplin.views.dialogs.setButtons(dialog, [
				{ id: 'ok', title: next },
				...(back ? [{ id: 'back', title: 'Back' }] : []),
				{ id: 'cancel', title: 'Cancel' },
			]);

			const result = await joplin.views.dialogs.open(dialog);
			if (result.id === 'back') return { action: 'back', choice: '' };
			if (result.id !== 'ok') return { action: 'cancel', choice: '' };

			const form = result.formData && result.formData.pickerForm;
			return { action: 'next', choice: form ? String(form.choice ?? '') : '' };
		};

		/**
		 * Notebook, then note, then - only when there is something to choose
		 * from - which section. Each step can go back to the one before it,
		 * which is why this is a loop rather than three awaits.
		 */
		const pickReference = async (): Promise<PickResult | null> => {
			clearFolderCache();

			let step = 1;
			let folderId = '';
			let folderCrumb = '';
			let notes: NoteEntry[] = [];
			let note: NoteEntry | null = null;

			for (;;) {
				if (step === 1) {
					const folders = await listFolders();
					const chosen = await openStep(
						folderStepHtml(folders, RECENT_LIMIT),
						'Next',
						false,
					);
					if (chosen.action !== 'next' || !chosen.choice) return null;

					folderId = chosen.choice;
					const folder = folders.find(entry => entry.id === folderId);
					folderCrumb = folder ? folder.path.join(' / ') : 'Recently edited notes';
					step = 2;
					continue;
				}

				if (step === 2) {
					notes = folderId === RECENT_ID
						? await listRecentNotes(RECENT_LIMIT)
						: await listNotesInFolder(folderId);

					const chosen = await openStep(
						noteStepHtml(notes, folderCrumb, folderId === RECENT_ID),
						'Next',
						true,
					);
					if (chosen.action === 'back') {
						step = 1;
						continue;
					}
					if (chosen.action !== 'next' || !chosen.choice) return null;

					const found = await listSections(chosen.choice);
					if (!found.note) return null;
					note = found.note;

					// A note with nothing marked up is reused whole, which is
					// what the third step would have offered anyway.
					if (!found.sections.length) {
						return { reference: await buildReference(note, ''), noteId: note.id };
					}

					const part = await openStep(sectionStepHtml(note, found.sections), 'Insert', true);
					if (part.action === 'back') {
						step = 2;
						continue;
					}
					if (part.action !== 'next') return null;

					return { reference: await buildReference(note, part.choice), noteId: note.id };
				}

				return null;
			}
		};

		// -------------------------------------------------------------
		// Content scripts
		// -------------------------------------------------------------
		await joplin.contentScripts.register(
			ContentScriptType.MarkdownItPlugin,
			MARKDOWN_IT_SCRIPT_ID,
			'./markdownItPlugin/index.js',
		);

		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CODE_MIRROR_SCRIPT_ID,
			'./codeMirrorPlugin/index.js',
		);

		// The viewer asks for the content of every reference in the note it is
		// drawing: a markdown-it rule cannot read another note, so this is
		// where the reference is actually resolved.
		await joplin.contentScripts.onMessage(MARKDOWN_IT_SCRIPT_ID, async (message: any) => {
			if (!message) return null;

			if (message.type === 'settings') {
				return {
					showSectionMarkers: (await setting('showSectionMarkers')) !== false,
					liveUpdate: (await setting('liveUpdate')) !== false,
				};
			}

			if (message.type === 'revision') return currentRevision();

			if (message.type === 'openNote' && message.id) {
				await joplin.commands.execute('openNote', message.id);
				return true;
			}

			if (message.type === 'embed') {
				const reference = parseReference(String(message.ref || ''));
				if (!reference) return null;

				const result = await resolveEmbed(reference);
				const options = {
					header: (await setting('showEmbedHeader')) !== false,
					colour: embedColour(await setting('embedColour')),
				};

				return {
					classes: embedClasses(result, options),
					html: embedHtml(result, options),
					revision: result.revision,
					ok: result.ok,
					// Stylesheets the borrowed content needs and the note it is
					// being drawn in may not have.
					assets: result.assets,
					css: result.css,
				};
			}

			return null;
		});

		await joplin.contentScripts.onMessage(CODE_MIRROR_SCRIPT_ID, async (message: any) => {
			if (!message) return null;

			if (message.type === 'settings') {
				return {
					editorHighlighting: (await setting('editorHighlighting')) !== false,
					suggestAsYouType: (await setting('suggestAsYouType')) !== false,
				};
			}

			// Every keystroke after `&&&/` that opens a new level lands here:
			// the editor has the text, but only this side has the notebooks.
			if (message.type === 'complete') {
				return await completeReference(String(message.rest || ''));
			}

			// A reference was just finished in the editor. Resolving it now
			// means the note draws it properly the first time, rather than
			// falling back to the viewer for one render.
			if (message.type === 'remember' && message.rest) {
				if (await remember(String(message.rest))) saveCache();
				return true;
			}

			return null;
		});

		// -------------------------------------------------------------
		// Keeping embedded content current
		// -------------------------------------------------------------
		await joplin.workspace.onNoteChange(async (event: any) => {
			if (!event || !event.id) return;
			notesChanged([event.id]);
			// What the changed note is borrowed for, and what it borrows.
			await refreshFor(event.id);
			await rememberNote(event.id);
		});

		await joplin.workspace.onNoteSelectionChange(async () => {
			const current = await joplin.workspace.selectedNote();
			if (current) await rememberNote(current.id);
		});

		// The references already known about may point at notes that changed
		// while Joplin was closed.
		const current = await joplin.workspace.selectedNote();
		if (current) await rememberNote(current.id);

		// -------------------------------------------------------------
		// Commands
		// -------------------------------------------------------------
		const insertText = async (text: string, editorCommand: string, arg: string) => {
			try {
				await joplin.commands.execute('editor.execCommand', {
					name: editorCommand,
					args: [arg],
				});
			} catch (_error) {
				// The rich text editor, or the legacy one: no editor command to
				// call, so fall back to plain text at the cursor.
				await joplin.commands.execute('insertText', text);
			}
		};

		await joplin.commands.register({
			name: INSERT_COMMAND,
			label: 'Reuse a section from another note...',
			iconName: 'fas fa-recycle',
			execute: async () => {
				const picked = await pickReference();
				if (!picked) return;

				// Resolved before it is written, so the note that is about to
				// be redrawn already has the content to hand.
				if (await remember(picked.reference.replace(/^&&&\//, ''))) saveCache();
				await insertText(picked.reference, 'reuseSections.insertReference', picked.reference);
			},
		});

		await joplin.commands.register({
			name: MARK_COMMAND,
			label: 'Mark selection as a shareable section',
			execute: async () => {
				await insertText('&&& \nContent to share\n/&&&\n', 'reuseSections.markSection', '');
			},
		});

		await joplin.commands.register({
			name: COPY_COMMAND,
			label: 'Copy a reference to this note...',
			execute: async () => {
				const current = await joplin.workspace.selectedNote();
				if (!current) return;

				const found = await listSections(current.id);
				if (!found.note) return;

				let section = '';
				if (found.sections.length) {
					const chosen = await openStep(
						sectionStepHtml(found.note, found.sections),
						'Copy',
						false,
					);
					if (chosen.action !== 'next') return;
					section = chosen.choice;
				}

				const reference = await buildReference(found.note, section);
				await joplin.clipboard.writeText(reference);

				// Toasts are newer than the plugin's minimum Joplin version.
				try {
					await joplin.views.dialogs.showToast({
						message: `Copied ${reference}`,
						duration: 3000,
						type: ToastType.Success,
					});
				} catch (_error) {
					// No toast on this version: the clipboard still has it.
				}
			},
		});

		await joplin.commands.register({
			name: REFRESH_COMMAND,
			label: 'Refresh reused content',
			execute: async () => {
				clearEmbedCache();

				let changed = false;
				for (const raw of Object.keys(cache)) {
					if (await remember(raw, true)) changed = true;
				}
				if (changed) saveCache();

				const note = await joplin.workspace.selectedNote();
				if (note) await rememberNote(note.id);
			},
		});

		// -------------------------------------------------------------
		// Toolbar and menus
		// -------------------------------------------------------------
		// The editor toolbar exists on both desktop and mobile, so it is
		// registered first: it is the only entry point on mobile.
		if ((await setting('showToolbarButton')) !== false) {
			await joplin.views.toolbarButtons.create(
				'reuseSectionsToolbarButton',
				INSERT_COMMAND,
				ToolbarButtonLocation.EditorToolbar,
			);
		}

		// `views.menus` is desktop-only - mobile has no menu bar - so a failure
		// here must not abort onStart and take the rest of the plugin with it.
		try {
			await joplin.views.menus.create(
				'reuseSectionsMenu',
				'Reuse Sections',
				[
					{ commandName: INSERT_COMMAND, label: 'Reuse a section...', accelerator: 'CmdOrCtrl+Alt+R' },
					{ commandName: MARK_COMMAND, label: 'Mark selection as a shareable section' },
					{ type: 'separator' },
					{ commandName: COPY_COMMAND, label: 'Copy a reference to this note...' },
					{ commandName: REFRESH_COMMAND, label: 'Refresh reused content' },
				],
				MenuItemLocation.Tools,
			);
		} catch (_error) {
			// No menu bar on this platform.
		}
	},
});
