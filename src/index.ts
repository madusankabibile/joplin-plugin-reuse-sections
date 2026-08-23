import joplin from 'api';
import {
	ContentScriptType,
	MenuItemLocation,
	SettingItemType,
	ToastType,
	ToolbarButtonLocation,
} from 'api/types';
import { formatReference, parseReference } from './reuse/syntax';
import { embedClasses, embedHtml } from './reuse/render';
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
				label: 'Update reused content as its source changes',
				description: 'Redraws an embedded section moments after the note it came from is edited.',
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
		});

		const applySettings = async () => {
			setResolveOptions({
				searchAnywhere: (await setting('searchAnywhere')) !== false,
				expandNested: (await setting('expandNested')) !== false,
			});
		};

		await applySettings();
		await joplin.settings.onChange(applySettings);

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
				const options = { header: (await setting('showEmbedHeader')) !== false };

				return {
					classes: embedClasses(result, options),
					html: embedHtml(result, options),
					revision: result.revision,
					ok: result.ok,
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

			return null;
		});

		// -------------------------------------------------------------
		// Keeping embedded content current
		// -------------------------------------------------------------
		await joplin.workspace.onNoteChange(async (event: any) => {
			if (event && event.id) notesChanged([event.id]);
		});

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
