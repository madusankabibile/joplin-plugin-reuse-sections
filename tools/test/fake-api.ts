// A stand-in for Joplin's `api` module, so `src/reuse/resolve.ts` can be run by
// `npm test` against fixture notebooks and notes instead of a real profile.
//
// `tools/run-tests.js` points the `api` import at this file.

interface FakeFolder {
	id: string;
	title: string;
	parent_id: string;
}

interface FakeNote {
	id: string;
	title: string;
	parent_id: string;
	updated_time: number;
	body: string;
}

export const folders: FakeFolder[] = [
	{ id: 'f-med', title: 'Medicine', parent_id: '' },
	{ id: 'f-ana', title: 'Anatomy', parent_id: 'f-med' },
	{ id: 'f-pha', title: 'Pharmacology', parent_id: 'f-med' },
	{ id: 'f-rec', title: 'Recipes', parent_id: '' },
];

export const notes: FakeNote[] = [
	{
		id: 'n-head',
		title: 'Head',
		parent_id: 'f-ana',
		updated_time: 5,
		body: [
			'# Head',
			'',
			'&&& brain Grey matter',
			'The **brain** sits inside the skull.',
			'/&&&',
			'',
			'&&& stem',
			'The brain stem connects to the spinal cord.',
			'/&&&',
			'',
			'&&&',
			'An unnamed part.',
			'/&&&',
		].join('\n'),
	},
	{
		id: 'n-neck',
		title: 'Neck and shoulders',
		parent_id: 'f-ana',
		updated_time: 4,
		body: 'No sections here.',
	},
	{ id: 'n-thorax', title: 'Thorax', parent_id: 'f-ana', updated_time: 3, body: '' },
	{
		id: 'n-dose',
		title: 'Dosages',
		parent_id: 'f-pha',
		updated_time: 2,
		// Reuses a section from another note, to exercise nested references.
		body: '&&& adult Adult dosage\n500 mg every 8 hours.\n\n&&&/Anatomy/Head/#stem\n/&&&',
	},
	{ id: 'n-soup', title: 'Leek soup', parent_id: 'f-rec', updated_time: 1, body: '' },
];

const page = (items: any[]) => ({ items, has_more: false });

/**
 * Whether `renderMarkup` is available, so both paths can be checked: Joplin's
 * own renderer, and the plugin's fallback for versions without the command.
 */
export const app = { hasRenderMarkup: true, lastRenderOptions: null as any };

const api: any = {
	data: {
		get: async (path: string[], query: any = {}) => {
			const [first, second, third] = path;

			if (first === 'folders' && !second) return page(folders);
			if (first === 'folders' && third === 'notes') {
				return page(notes.filter(note => note.parent_id === second));
			}
			if (first === 'notes' && second) {
				const note = notes.find(item => item.id === second);
				if (!note) throw new Error('Not found');
				return note;
			}
			if (first === 'notes') {
				const recent = [...notes].sort((a, b) => b.updated_time - a.updated_time);
				return page(query.limit ? recent.slice(0, query.limit) : recent);
			}
			if (first === 'search') {
				const wanted = String(query.query || '').replace(/^title:"|"$/g, '').toLowerCase();
				return page(notes.filter(note => note.title.toLowerCase() === wanted));
			}

			// Anything else - resources in particular - is simply not there.
			throw new Error('Not found');
		},
		resourcePath: async () => '',
	},

	commands: {
		execute: async (name: string, _language: number, markup: string, _rendererOptions: any, options: any) => {
			if (name !== 'renderMarkup' || !app.hasRenderMarkup) {
				throw new Error(`Command not found: ${name}`);
			}

			app.lastRenderOptions = options;

			// Stands in for the real renderer: enough to tell that the markup
			// went through it rather than through the plugin's own markdown-it.
			return {
				html: `<div class="joplin-rendered">${markup}</div>`,
				pluginAssets: [
					{ name: 'katex/katex.css', path: '/assets/katex.css', pathIsAbsolute: false, mime: 'text/css' },
					{ name: 'mermaid/mermaid.js', path: '/assets/mermaid.js', pathIsAbsolute: false, mime: 'application/javascript' },
				],
				cssStrings: ['.joplin-rendered { color: inherit; }'],
			};
		},
	},
};

export default api;
