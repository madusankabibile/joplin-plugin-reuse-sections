// Turning a reference into content, and the data API queries the picker needs.
//
// This is the only file that talks to Joplin's data API, and it runs in the
// plugin process, never in a content script.

import joplin from 'api';
import {
	Reference,
	escapeSegment,
	extractSections,
	findSection,
	lastSegmentStart,
	parseRefLine,
	referenceSegments,
	sectionTitle,
	stripFences,
	summarise,
} from './syntax';
import {
	CompletionOption,
	CompletionReply,
	EmbedAsset,
	EmbedResult,
	FolderEntry,
	NoteEntry,
	SectionEntry,
} from './types';
import { RenderContext, collectItemIds, emptyContext, renderMarkdown } from './markdown';

/** How many levels of "a reused section that reuses another one" to follow. */
const MAX_DEPTH = 3;

/** Notebook names change rarely, and the picker refreshes them on open. */
const FOLDER_TTL = 60 * 1000;

interface FolderRecord {
	id: string;
	title: string;
	parent_id: string;
}

interface NoteRecord {
	id: string;
	title: string;
	parent_id: string;
	body: string;
}

export interface ResolveOptions {
	/** Look for the note anywhere when the notebook path no longer matches. */
	searchAnywhere: boolean;
	/** Follow references inside the content that was pulled in. */
	expandNested: boolean;
}

let options: ResolveOptions = { searchAnywhere: true, expandNested: true };

export const setResolveOptions = (next: Partial<ResolveOptions>) => {
	options = { ...options, ...next };
	embedCache.clear();
	bumpRevision();
};

// ---------------------------------------------------------------------------
// Data API helpers
// ---------------------------------------------------------------------------

/** Follows `has_more` so a caller never has to think about pagination. */
const getAll = async (path: string[], query: any = {}): Promise<any[]> => {
	const out: any[] = [];
	let page = 1;

	for (;;) {
		const response = await joplin.data.get(path, { ...query, page, limit: 100 });
		const items = response && response.items ? response.items : [];
		out.push(...items);
		if (!response || !response.has_more || page > 200) break;
		page++;
	}

	return out;
};

// ---------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------

let folderCache: Map<string, FolderRecord> | null = null;
let folderCacheTime = 0;

export const clearFolderCache = () => {
	folderCache = null;
};

const loadFolders = async (): Promise<Map<string, FolderRecord>> => {
	if (folderCache && Date.now() - folderCacheTime < FOLDER_TTL) return folderCache;

	const items = await getAll(['folders'], { fields: ['id', 'title', 'parent_id'] });
	folderCache = new Map(items.map((item: FolderRecord) => [item.id, item]));
	folderCacheTime = Date.now();
	return folderCache;
};

/** The names of every notebook down to `folderId`, outermost first. */
const pathOf = (folders: Map<string, FolderRecord>, folderId: string): string[] => {
	const out: string[] = [];
	let current = folders.get(folderId);
	// `seen` guards against a parent loop, which sync conflicts can produce.
	const seen = new Set<string>();

	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		out.unshift(current.title);
		current = current.parent_id ? folders.get(current.parent_id) : undefined;
	}

	return out;
};

export const folderPathOf = async (folderId: string): Promise<string[]> =>
	pathOf(await loadFolders(), folderId);

const same = (a: string, b: string): boolean =>
	String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * The notebook a reference points at. The path is matched from the inside out,
 * so `&&&/anatomy/head` keeps working after "Anatomy" is filed under a new
 * parent notebook.
 */
const matchFolder = (folders: Map<string, FolderRecord>, wanted: string[]): FolderRecord | null => {
	if (!wanted.length) return null;

	let best: FolderRecord | null = null;

	for (const folder of folders.values()) {
		const path = pathOf(folders, folder.id);
		if (path.length < wanted.length) continue;

		const tail = path.slice(path.length - wanted.length);
		if (!tail.every((part, index) => same(part, wanted[index]))) continue;

		// An exact path beats a match on the last notebooks only.
		if (path.length === wanted.length) return folder;
		if (!best) best = folder;
	}

	return best;
};

export const listFolders = async (): Promise<FolderEntry[]> => {
	const folders = await loadFolders();

	const entries: FolderEntry[] = Array.from(folders.values()).map(folder => {
		const path = pathOf(folders, folder.id);
		return {
			id: folder.id,
			title: folder.title,
			path,
			depth: path.length - 1,
		};
	});

	// Compared name by name rather than as one joined string, so a notebook
	// always sits directly above the notebooks filed inside it.
	entries.sort((a, b) => {
		for (let i = 0; i < Math.max(a.path.length, b.path.length); i++) {
			const left = (a.path[i] || '').toLowerCase();
			const right = (b.path[i] || '').toLowerCase();
			if (left !== right) return left < right ? -1 : 1;
		}
		return 0;
	});

	return entries;
};

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const toNoteEntry = async (note: any): Promise<NoteEntry> => ({
	id: note.id,
	title: note.title || '(Untitled)',
	folderPath: await folderPathOf(note.parent_id),
	updatedTime: note.updated_time || 0,
});

export const listNotesInFolder = async (folderId: string): Promise<NoteEntry[]> => {
	const notes = await getAll(['folders', folderId, 'notes'], {
		fields: ['id', 'title', 'parent_id', 'updated_time'],
		order_by: 'title',
		order_dir: 'ASC',
	});

	const out: NoteEntry[] = [];
	for (const note of notes) out.push(await toNoteEntry(note));
	return out;
};

export const listRecentNotes = async (limit = 100): Promise<NoteEntry[]> => {
	const response = await joplin.data.get(['notes'], {
		fields: ['id', 'title', 'parent_id', 'updated_time'],
		order_by: 'updated_time',
		order_dir: 'DESC',
		limit,
	});

	const out: NoteEntry[] = [];
	for (const note of (response && response.items ? response.items : [])) {
		out.push(await toNoteEntry(note));
	}
	return out;
};

const getNote = async (noteId: string): Promise<NoteRecord | null> => {
	try {
		return await joplin.data.get(['notes', noteId], {
			fields: ['id', 'title', 'parent_id', 'body'],
		});
	} catch (_error) {
		return null;
	}
};

/** Notes with this exact title, anywhere - the fallback when a path moves. */
const searchByTitle = async (title: string): Promise<NoteRecord[]> => {
	const clean = String(title || '').replace(/["]/g, ' ').trim();
	if (!clean) return [];

	try {
		const response = await joplin.data.get(['search'], {
			query: `title:"${clean}"`,
			type: 'note',
			fields: ['id', 'title', 'parent_id', 'body'],
			limit: 20,
		});
		const items: NoteRecord[] = response && response.items ? response.items : [];
		return items.filter(note => same(note.title, title));
	} catch (_error) {
		return [];
	}
};

const resolveNote = async (reference: Reference): Promise<NoteRecord | null> => {
	if (reference.noteId) return getNote(reference.noteId);

	const folders = await loadFolders();
	const folder = matchFolder(folders, reference.folderPath);

	if (folder) {
		const notes = await getAll(['folders', folder.id, 'notes'], {
			fields: ['id', 'title', 'parent_id'],
		});
		const match = notes.find((note: NoteRecord) => same(note.title, reference.noteTitle));
		if (match) return getNote(match.id);
	}

	if (!options.searchAnywhere && reference.folderPath.length) return null;

	const found = await searchByTitle(reference.noteTitle);
	if (!found.length) return null;

	// Several notes share the title: prefer one whose notebook path still looks
	// like the reference, so a stale path picks the closest thing to it.
	if (found.length > 1 && reference.folderPath.length) {
		const wanted = reference.folderPath.map(part => part.toLowerCase()).join('/');
		const scored = found.map(note => {
			const path = pathOf(folders, note.parent_id).map(part => part.toLowerCase()).join('/');
			return { note, hit: path.endsWith(wanted) };
		});
		const best = scored.find(entry => entry.hit);
		if (best) return getNote(best.note.id);
	}

	return getNote(found[0].id);
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const listSections = async (noteId: string): Promise<{
	note: NoteEntry | null;
	sections: SectionEntry[];
}> => {
	const note = await getNote(noteId);
	if (!note) return { note: null, sections: [] };

	const sections = extractSections(note.body).map(section => ({
		id: section.id,
		title: sectionTitle(section),
		index: section.index,
		lines: section.content ? section.content.split('\n').length : 0,
		preview: summarise(section.content, 400),
	}));

	return { note: await toNoteEntry(note), sections };
};

// ---------------------------------------------------------------------------
// Completing a reference as it is typed
// ---------------------------------------------------------------------------

/** How many recently edited notes the drop-down offers before you pick a notebook. */
const COMPLETION_RECENT = 12;

const folderOption = (path: string[], relative: string[], parent: string): CompletionOption => ({
	label: path[path.length - 1] || '(Untitled)',
	detail: parent ? `notebook in ${parent}` : 'notebook',
	// A trailing slash, because a notebook is never the end of a reference.
	insert: `${relative.map(escapeSegment).join('/')}/`,
	continues: true,
	boost: 1,
});

const noteOption = (title: string, where: string, relative: string[]): CompletionOption => ({
	label: title || '(Untitled)',
	detail: where ? `note in ${where}` : 'note',
	insert: relative.map(escapeSegment).join('/'),
	continues: false,
});

/** Nothing typed yet: every notebook, and the notes worked on most recently. */
const topLevelOptions = async (): Promise<CompletionOption[]> => {
	const folders = await listFolders();
	const options: CompletionOption[] = folders.map(folder =>
		folderOption(folder.path, folder.path, folder.path.slice(0, -1).join(' / ')));

	for (const note of await listRecentNotes(COMPLETION_RECENT)) {
		options.push(noteOption(
			note.title,
			note.folderPath.join(' / '),
			[...note.folderPath, note.title],
		));
	}

	return options;
};

/** Inside a notebook: the notebooks within it, then its notes. */
const folderOptions = async (
	folders: Map<string, FolderRecord>,
	folder: FolderRecord,
): Promise<CompletionOption[]> => {
	const options: CompletionOption[] = [];

	for (const child of folders.values()) {
		if (child.parent_id !== folder.id) continue;
		options.push(folderOption(pathOf(folders, child.id), [child.title], folder.title));
	}

	options.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));

	const notes = await getAll(['folders', folder.id, 'notes'], {
		fields: ['id', 'title'],
		order_by: 'title',
		order_dir: 'ASC',
	});
	for (const note of notes) options.push(noteOption(note.title, folder.title, [note.title]));

	return options;
};

/** After a note: the parts of it that are marked as shareable. */
const sectionOptions = (note: NoteRecord): CompletionOption[] =>
	extractSections(note.body).map(section => ({
		label: `#${section.id}`,
		detail: section.label || summarise(section.content, 60) || 'section',
		insert: `#${escapeSegment(section.id)}`,
		continues: false,
	}));

/**
 * What to offer for the reference being typed, where `rest` is everything
 * between `&&&/` and the cursor.
 *
 * The level is worked out by resolving what has been typed so far rather than
 * by counting slashes: `&&&/medicine/anatomy/` is a notebook two deep, and
 * `&&&/anatomy/head/` is a note - and both look the same from the outside.
 */
export const completeReference = async (rest: string): Promise<CompletionReply> => {
	const text = String(rest || '');
	const from = text.length - lastSegmentStart(text);

	const segments = referenceSegments(text);
	segments.pop(); // The part still being typed - the drop-down filters on it.
	const prefix = segments.filter(part => part !== '');

	if (!prefix.length) return { from, options: await topLevelOptions() };

	const folders = await loadFolders();

	// A notebook wins over a note of the same name: it is the one you can
	// carry on typing into.
	const folder = matchFolder(folders, prefix);
	if (folder) return { from, options: await folderOptions(folders, folder) };

	const note = await resolveNote({
		folderPath: prefix.slice(0, -1),
		noteTitle: prefix[prefix.length - 1],
		noteId: '',
		section: '',
		raw: text,
	});

	return { from, options: note ? sectionOptions(note) : [] };
};

// ---------------------------------------------------------------------------
// Resolving a reference into HTML
// ---------------------------------------------------------------------------

let revision = 1;

export const currentRevision = (): number => revision;

const bumpRevision = () => {
	revision++;
};

const embedCache = new Map<string, EmbedResult>();

/** Drops what the changed notes were used for, so the viewer redraws them. */
export const notesChanged = (noteIds: string[]) => {
	const ids = new Set(noteIds);
	let dirty = false;

	for (const [key, result] of embedCache) {
		// Failed lookups are dropped too: the note a reference is waiting for
		// may be the one that has just been created or renamed.
		if (!result.ok || ids.has(result.noteId)) {
			embedCache.delete(key);
			dirty = true;
		}
	}

	if (dirty) {
		clearFolderCache();
		bumpRevision();
	}
};

export const clearEmbedCache = () => {
	embedCache.clear();
	clearFolderCache();
	bumpRevision();
};

const failure = (raw: string, error: string): EmbedResult => ({
	ok: false,
	raw,
	html: '',
	noteId: '',
	noteTitle: '',
	folderPath: [],
	sectionTitle: '',
	error,
	revision,
	assets: [],
	css: [],
});

/** The markdown a reference stands for, with nested references filled in. */
const contentFor = async (
	reference: Reference,
	depth: number,
	seen: Set<string>,
): Promise<{ note: NoteRecord; markdown: string; section: string } | { error: string }> => {
	const note = await resolveNote(reference);
	if (!note) {
		return {
			error: reference.noteId
				? 'That note no longer exists'
				: `No note called "${reference.noteTitle}"`,
		};
	}

	let markdown: string;
	let title = '';

	if (reference.section) {
		const sections = extractSections(note.body);
		const section = findSection(sections, reference.section);
		if (!section) {
			return { error: `"${note.title}" has no section called "${reference.section}"` };
		}
		markdown = section.content;
		title = sectionTitle(section);
	} else {
		markdown = stripFences(note.body);
	}

	const key = `${note.id}#${reference.section.toLowerCase()}`;
	if (seen.has(key)) return { error: 'This reference points back at itself' };
	seen.add(key);

	if (options.expandNested && depth < MAX_DEPTH) {
		markdown = await expandNested(markdown, depth + 1, seen);
	}

	return { note, markdown, section: title };
};

/** Replaces reference lines inside borrowed content with what they point at. */
const expandNested = async (markdown: string, depth: number, seen: Set<string>): Promise<string> => {
	const lines = markdown.split('\n');
	let changed = false;

	for (let i = 0; i < lines.length; i++) {
		const reference = parseRefLine(lines[i]);
		if (!reference) continue;

		const nested = await contentFor(reference, depth, new Set(seen));
		changed = true;
		lines[i] = 'error' in nested
			? `*${nested.error}*`
			: nested.markdown;
	}

	return changed ? lines.join('\n') : markdown;
};

// ---------------------------------------------------------------------------
// Markdown to HTML
// ---------------------------------------------------------------------------

/** Joplin's `MarkupLanguage.Markdown`, which the plugin API does not export. */
const MARKUP_MARKDOWN = 1;

interface RenderedMarkup {
	html: string;
	assets: EmbedAsset[];
	css: string[];
}

/**
 * The resources the borrowed markdown refers to, in the shape Joplin's
 * renderer expects, so its own rules can draw the images.
 */
const buildResourceInfos = async (markdown: string): Promise<Record<string, any>> => {
	const infos: Record<string, any> = {};

	for (const id of collectItemIds(markdown)) {
		try {
			const item = await joplin.data.get(['resources', id], {
				fields: [
					'id', 'title', 'mime', 'filename', 'file_extension', 'size',
					'encryption_applied', 'encryption_blob_encrypted', 'is_shared', 'updated_time',
				],
			});
			infos[id] = { item, localState: { fetch_status: 2 } };
		} catch (_error) {
			// Not a resource - a link to another note, most likely, which the
			// renderer handles by itself.
		}
	}

	return infos;
};

/**
 * Renders through Joplin's own pipeline, which is what makes an embed look
 * exactly like the note it came from: every other markdown-it content script
 * runs over it too, so another plugin's blocks, fences and diagrams come
 * through as blocks, fences and diagrams rather than as their markup.
 *
 * Returns null on any older version that does not have the command, and the
 * caller falls back to the plugin's own renderer.
 */
const renderThroughJoplin = async (markdown: string): Promise<RenderedMarkup | null> => {
	try {
		const result = await joplin.commands.execute(
			'renderMarkup',
			MARKUP_MARKDOWN,
			markdown,
			null,
			{
				bodyOnly: true,
				resources: await buildResourceInfos(markdown),
			},
		);

		if (!result || typeof result.html !== 'string') return null;

		return {
			// Joplin sanitises its own output, so it is used as it arrives.
			html: result.html,
			assets: (result.pluginAssets || []).filter((asset: EmbedAsset) =>
				asset && /\.css$/i.test(asset.name || '')),
			css: result.cssStrings || [],
		};
	} catch (_error) {
		return null;
	}
};

/** Resolves `:/<id>` links and images, which mean nothing outside Joplin. */
const buildRenderContext = async (markdown: string): Promise<RenderContext> => {
	const context = emptyContext();

	for (const id of collectItemIds(markdown)) {
		try {
			await joplin.data.get(['resources', id], { fields: ['id'] });
			const path = await joplin.data.resourcePath(id);
			context.resources[id] = `file:///${String(path).replace(/\\/g, '/').replace(/^\/+/, '')}`;
			continue;
		} catch (_error) {
			// Not a resource, or not downloaded on this device.
		}

		try {
			await joplin.data.get(['notes', id], { fields: ['id'] });
			context.notes[id] = true;
		} catch (_error) {
			// Neither: leave the link as it was written.
		}
	}

	return context;
};

/** Joplin's renderer when it is there, the plugin's own when it is not. */
const renderMarkup = async (markdown: string): Promise<RenderedMarkup> => {
	const joplinRendered = await renderThroughJoplin(markdown);
	if (joplinRendered) return joplinRendered;

	return {
		html: renderMarkdown(markdown, await buildRenderContext(markdown)),
		assets: [],
		css: [],
	};
};

export const resolveEmbed = async (reference: Reference): Promise<EmbedResult> => {
	// Everything that goes back to the viewer is stamped with the revision as
	// it is now, not as it was when the content was cached: the viewer compares
	// the two to decide whether to ask again, and a stale stamp would have it
	// asking for ever.
	const cached = embedCache.get(reference.raw);
	if (cached) return { ...cached, revision };

	let result: EmbedResult;

	try {
		const content = await contentFor(reference, 0, new Set<string>());

		if ('error' in content) {
			result = failure(reference.raw, content.error);
		} else {
			const rendered = content.markdown.trim()
				? await renderMarkup(content.markdown)
				: { html: '<p class="rsx-missing">This section is empty.</p>', assets: [], css: [] };

			result = {
				ok: true,
				raw: reference.raw,
				html: rendered.html,
				noteId: content.note.id,
				noteTitle: content.note.title || '(Untitled)',
				folderPath: await folderPathOf(content.note.parent_id),
				sectionTitle: content.section,
				error: '',
				revision,
				assets: rendered.assets,
				css: rendered.css,
			};
		}
	} catch (error) {
		result = failure(reference.raw, `Could not read that note: ${error.message}`);
	}

	embedCache.set(reference.raw, result);
	return { ...result, revision };
};
