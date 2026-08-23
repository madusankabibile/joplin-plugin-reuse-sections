// The shapes that travel between the plugin, the two content scripts and the
// picker dialog. Everything here has to survive `JSON.stringify`, because that
// is what a `postMessage` round trip does to it.

/** A resolved embed, ready for the note viewer. */
export interface EmbedResult {
	ok: boolean;
	/** The reference as written, without the `&&&/` marker. */
	raw: string;
	/** The rendered HTML of the embedded content ('' when `ok` is false). */
	html: string;
	/** The source note's id, for the header link and for change tracking. */
	noteId: string;
	noteTitle: string;
	/** The notebook path of the source note, outermost first. */
	folderPath: string[];
	/** The section that was embedded, or '' for a whole note. */
	sectionTitle: string;
	/** Set when `ok` is false. */
	error: string;
	/** Bumped whenever the source note changes, so the viewer can refresh. */
	revision: number;
}

/** A notebook, as the first step of the picker shows it. */
export interface FolderEntry {
	id: string;
	title: string;
	/** Full path, outermost first, including `title`. */
	path: string[];
	depth: number;
}

/** A note, as the second step of the picker shows it. */
export interface NoteEntry {
	id: string;
	title: string;
	folderPath: string[];
	updatedTime: number;
}

/** A shareable section, as the third step of the picker shows it. */
export interface SectionEntry {
	id: string;
	title: string;
	index: number;
	lines: number;
	preview: string;
}

/** What the picker hands back once the user has chosen. */
export interface PickResult {
	/** The reference text, `&&&/` marker included. */
	reference: string;
	noteId: string;
}

/** One line of the drop-down that opens as a reference is typed. */
export interface CompletionOption {
	label: string;
	/** The dimmer text on the right: what kind of thing this is. */
	detail: string;
	/** The text that replaces the segment being typed. */
	insert: string;
	/** There is more to choose after this one, so reopen the list. */
	continues: boolean;
	/** Nudges an entry up or down the list. */
	boost?: number;
}

export interface CompletionReply {
	/** How many characters before the cursor the chosen text replaces. */
	from: number;
	options: CompletionOption[];
}
