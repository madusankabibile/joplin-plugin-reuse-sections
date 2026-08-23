// All of the HTML the plugin produces, in one place.
//
// The markdown-it content script uses this for the placeholder it leaves in the
// note, the main plugin uses it for the finished embed it sends back, and the
// picker dialog uses the same escaping. Nothing here talks to markdown-it or to
// the data API, so it can be imported from either side.

import { EmbedResult } from './types';

export const escapeHtml = (text: string): string => String(text)
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

/** The class every embed and every section marker is built on. */
export const EMBED_CLASS = 'rsx-embed';

/**
 * What may be drawn around borrowed content. The colours tint the box and the
 * rule down its side; `outline` keeps the frame without the tint, and `none`
 * leaves the content to sit in the note with nothing around it at all.
 */
export const EMBED_COLOURS = [
	'violet', 'blue', 'teal', 'green', 'amber', 'red', 'grey', 'outline', 'none',
];

export const DEFAULT_COLOUR = 'violet';

/** Whatever the setting says, narrowed to something with a stylesheet. */
export const embedColour = (value: any): string => {
	const name = String(value || '');
	return EMBED_COLOURS.indexOf(name) === -1 ? DEFAULT_COLOUR : name;
};

export interface EmbedOptions {
	/** Draw the source line above the content. */
	header: boolean;
	/** One of `EMBED_COLOURS`. */
	colour: string;
}

/**
 * The empty shell the markdown-it rule leaves behind. The content is filled in
 * from the viewer script, which is the only side of the renderer that is
 * allowed to be asynchronous - and therefore the only side that can read
 * another note.
 */
export const embedPlaceholder = (raw: string, label: string): string =>
	`<div class="${EMBED_CLASS} rsx-loading" data-rsx-ref="${escapeHtml(raw)}">` +
	`<div class="rsx-embed-inner"><div class="rsx-status">${escapeHtml(label)}</div></div>` +
	'</div>';

const sourceLabel = (result: { folderPath: string[]; noteTitle: string }): string => {
	const parts = [...result.folderPath, result.noteTitle].filter(part => !!part);
	return parts.join(' / ');
};

/** The head of an embed: where this content actually lives. */
const headHtml = (source: { folderPath: string[]; noteTitle: string; noteId: string;
	sectionTitle: string }): string => {
	const label = sourceLabel(source);

	return '<div class="rsx-head">' +
		`<a class="rsx-source" href="#" data-rsx-note="${escapeHtml(source.noteId)}" ` +
		`title="Open ${escapeHtml(label)}">${escapeHtml(label)}</a>` +
		(source.sectionTitle
			? `<span class="rsx-chip">${escapeHtml(source.sectionTitle)}</span>`
			: '<span class="rsx-chip rsx-chip-note">whole note</span>') +
		'</div>';
};

/**
 * An embed whose content is tokenized into the note itself, rather than fetched
 * by the viewer: the open tag, then the borrowed tokens, then the close tag.
 */
export interface EmbedMeta {
	raw: string;
	noteId: string;
	noteTitle: string;
	folderPath: string[];
	sectionTitle: string;
	header: boolean;
	/** One of `EMBED_COLOURS`. */
	colour: string;
}

export const embedOpen = (meta: EmbedMeta): string => {
	const classes = [EMBED_CLASS, 'rsx-ready', 'rsx-inline', `rsx-c-${embedColour(meta.colour)}`];
	if (!meta.header) classes.push('rsx-bare');
	if (!meta.sectionTitle) classes.push('rsx-whole-note');

	return `<div class="${classes.join(' ')}" data-rsx-source="${escapeHtml(meta.raw)}">` +
		'<div class="rsx-embed-inner">' +
		(meta.header ? headHtml(meta) : '') +
		'<div class="rsx-body">';
};

export const embedClose = (): string => '</div></div></div>';

/** A reference that resolves to nothing, drawn without a trip to the viewer. */
export const referenceError = (raw: string, error: string): string =>
	`<div class="${EMBED_CLASS} rsx-failed" data-rsx-source="${escapeHtml(raw)}">` +
	'<div class="rsx-embed-inner"><div class="rsx-error">' +
	`<span class="rsx-error-title">${escapeHtml(error)}</span>` +
	`<code class="rsx-error-ref">&amp;&amp;&amp;/${escapeHtml(raw)}</code>` +
	'</div></div></div>';

/** The finished embed: a source line, then the content of the other note. */
export const embedHtml = (result: EmbedResult, options: EmbedOptions): string => {
	if (!result.ok) {
		return '<div class="rsx-embed-inner">' +
			'<div class="rsx-error">' +
			`<span class="rsx-error-title">${escapeHtml(result.error || 'Could not resolve this reference')}</span>` +
			`<code class="rsx-error-ref">&amp;&amp;&amp;/${escapeHtml(result.raw)}</code>` +
			'</div></div>';
	}

	const header = options.header ? headHtml(result) : '';

	return `<div class="rsx-embed-inner">${header}<div class="rsx-body">${result.html}</div></div>`;
};

/** The class list of the outer element, so the viewer can swap states. */
export const embedClasses = (result: EmbedResult, options: EmbedOptions): string => {
	const out = [EMBED_CLASS, result.ok ? 'rsx-ready' : 'rsx-failed', `rsx-c-${embedColour(options.colour)}`];
	if (result.ok && !options.header) out.push('rsx-bare');
	if (result.ok && !result.sectionTitle) out.push('rsx-whole-note');
	return out.join(' ');
};

// ---------------------------------------------------------------------------
// The source note's own sections
// ---------------------------------------------------------------------------

export interface SectionMeta {
	id: string;
	label: string;
	index: number;
	unclosed: boolean;
	/** "Outline shareable sections" is off: keep the content, drop the frame. */
	hidden: boolean;
	/** One of `EMBED_COLOURS`, so a section is marked in the same colour. */
	colour: string;
}

/**
 * A section in the note that defines it. It is deliberately quiet - a rule down
 * the side and a small name - because this is content the author is reading,
 * not a box they asked for.
 */
export const sectionOpen = (meta: SectionMeta): string => {
	const name = meta.label
		? `${escapeHtml(meta.id)} <span class="rsx-section-label">${escapeHtml(meta.label)}</span>`
		: escapeHtml(meta.id);

	const classes = ['rsx-section', `rsx-c-${embedColour(meta.colour)}`];
	if (meta.unclosed) classes.push('rsx-section-unclosed');
	if (meta.hidden) classes.push('rsx-section-plain');

	return `<div class="${classes.join(' ')}" data-rsx-section="${escapeHtml(meta.id)}">` +
		(meta.hidden ? '' : `<div class="rsx-section-tag">${name}</div>`) +
		'<div class="rsx-section-body">';
};

export const sectionClose = (): string => '</div></div>';
