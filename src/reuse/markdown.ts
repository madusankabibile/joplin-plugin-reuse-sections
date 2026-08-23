// The fallback renderer for borrowed content.
//
// Normally `resolve.ts` renders an embed with Joplin's own renderer, through
// the `renderMarkup` command, so that every other markdown-it content script
// runs over it as well. This markdown-it is what happens instead on a version
// of Joplin that does not have that command: plain CommonMark plus tables and
// strikethrough, with `:/<id>` images and note links rewritten here, because
// they mean nothing outside Joplin's renderer.

import MarkdownIt from 'markdown-it';

/** Ids the note refers to, resolved by the caller before rendering. */
export interface RenderContext {
	/** Resource id -> a URL the viewer can load. */
	resources: Record<string, string>;
	/** Ids that turned out to be notes, so links can open them. */
	notes: Record<string, boolean>;
}

export const emptyContext = (): RenderContext => ({ resources: {}, notes: {} });

/** Every `:/<id>` in the markdown, deduplicated. */
export const collectItemIds = (markdown: string): string[] => {
	const found = new Set<string>();
	const re = /:\/([0-9a-zA-Z]{16,64})/g;
	let match: RegExpExecArray | null;

	while ((match = re.exec(String(markdown || '')))) found.add(match[1]);
	return Array.from(found);
};

const itemId = (url: string): string => {
	if (!url || !url.startsWith(':/')) return '';
	return url.slice(2).replace(/[?#].*$/, '');
};

const markdownIt = new MarkdownIt({
	html: true,
	linkify: true,
	typographer: false,
	breaks: false,
});

// Joplin's own renderer resolves `:/<id>` against the resource directory; ours
// gets the same information handed to it as `env`.
markdownIt.renderer.rules.image = (tokens, idx, options, env: RenderContext, self) => {
	const token = tokens[idx];
	const id = itemId(token.attrGet('src') || '');

	if (id) {
		const url = env && env.resources ? env.resources[id] : '';
		if (url) {
			token.attrSet('src', url);
		} else {
			// The resource is not on this device (or is a note, or is gone):
			// say so rather than drawing a broken image icon.
			const alt = token.content || 'attachment';
			return `<span class="rsx-missing" title="Attachment not available">${
				markdownIt.utils.escapeHtml(alt)}</span>`;
		}
	}

	return self.renderToken(tokens, idx, options);
};

markdownIt.renderer.rules.link_open = (tokens, idx, options, env: RenderContext, self) => {
	const token = tokens[idx];
	const id = itemId(token.attrGet('href') || '');

	if (id) {
		if (env && env.notes && env.notes[id]) {
			// Handled by the viewer script, which asks the plugin to open it.
			token.attrSet('href', '#');
			token.attrSet('data-rsx-note', id);
		} else if (env && env.resources && env.resources[id]) {
			token.attrSet('href', env.resources[id]);
		}
	}

	return self.renderToken(tokens, idx, options);
};

// The content is the user's own, but it is injected with innerHTML rather than
// going through Joplin's sanitiser, so anything that could run is taken out.
const scrub = (html: string): string => html
	.replace(/<\s*(script|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
	.replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*>/gi, '')
	.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
	.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
	.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
	.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');

export const renderMarkdown = (markdown: string, context: RenderContext): string => {
	try {
		return scrub(markdownIt.render(String(markdown || ''), context));
	} catch (error) {
		return `<p class="rsx-missing">${markdownIt.utils.escapeHtml(
			`Could not render this content: ${error.message}`)}</p>`;
	}
};
