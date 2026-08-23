// The bridge between the plugin and the note viewer.
//
// A markdown-it rule is synchronous: it cannot read another note while the
// viewer is drawing one. It can, however, read this plugin's own settings
// synchronously - Joplin hands content scripts a `settingValue()` for exactly
// that. So the plugin keeps the markdown of everything the open notes borrow in
// a setting, and the rule reads it from there.
//
// Which is what makes an embed render properly: with the markdown in hand at
// render time, the borrowed content is tokenized as part of the note that
// borrows it, by the whole pipeline - so every other markdown-it plugin, and
// Joplin's own maths and diagrams, apply to it exactly as they would at home.

/** One resolved reference: the markdown it stands for, and where it came from. */
export interface CachedEmbed {
	markdown: string;
	noteId: string;
	noteTitle: string;
	/** Notebook names, outermost first. */
	folderPath: string[];
	/** The section that was taken, or '' for a whole note. */
	sectionTitle: string;
	/** Set instead of `markdown` when the reference resolves to nothing. */
	error?: string;
}

/** Keyed by the reference as written, without the `&&&/` marker. */
export type EmbedCache = Record<string, CachedEmbed>;

/** Beyond this the setting is doing more harm than the caching does good. */
export const MAX_ENTRIES = 150;
export const MAX_CHARS = 800 * 1000;

export const parseCache = (raw: string): EmbedCache => {
	if (!raw) return {};

	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || !parsed.entries) return {};

		const out: EmbedCache = {};
		for (const key of Object.keys(parsed.entries)) {
			const entry = parsed.entries[key];
			if (!entry || typeof entry !== 'object') continue;

			out[key] = {
				markdown: typeof entry.markdown === 'string' ? entry.markdown : '',
				noteId: typeof entry.noteId === 'string' ? entry.noteId : '',
				noteTitle: typeof entry.noteTitle === 'string' ? entry.noteTitle : '',
				folderPath: Array.isArray(entry.folderPath) ? entry.folderPath.map(String) : [],
				sectionTitle: typeof entry.sectionTitle === 'string' ? entry.sectionTitle : '',
				...(entry.error ? { error: String(entry.error) } : {}),
			};
		}
		return out;
	} catch (_error) {
		// A blob written by a newer version, or one that got truncated: start
		// again rather than leaving every embed broken.
		return {};
	}
};

/**
 * Serialises the cache, dropping the oldest entries until it fits. Insertion
 * order is the order of `Object.keys`, so the entries added most recently -
 * which are the ones being looked at - are the ones kept.
 */
export const serialiseCache = (cache: EmbedCache): string => {
	let keys = Object.keys(cache);
	if (keys.length > MAX_ENTRIES) keys = keys.slice(keys.length - MAX_ENTRIES);

	for (;;) {
		const entries: EmbedCache = {};
		for (const key of keys) entries[key] = cache[key];

		const text = JSON.stringify({ version: 1, entries });
		if (text.length <= MAX_CHARS || keys.length <= 1) return text;

		keys = keys.slice(Math.ceil(keys.length / 4));
	}
};
