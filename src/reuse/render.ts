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

export interface EmbedOptions {
	/** Draw the source line above the content. */
	header: boolean;
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

const sourceLabel = (result: EmbedResult): string => {
	const parts = [...result.folderPath, result.noteTitle].filter(part => !!part);
	return parts.join(' / ');
};

/** The finished embed: a source line, then the content of the other note. */
export const embedHtml = (result: EmbedResult, options: EmbedOptions): string => {
	if (!result.ok) {
		return '<div class="rsx-embed-inner">' +
			'<div class="rsx-error">' +
			`<span class="rsx-error-title">${escapeHtml(result.error || 'Could not resolve this reference')}</span>` +
			`<code class="rsx-error-ref">&amp;&amp;&amp;/${escapeHtml(result.raw)}</code>` +
			'</div></div>';
	}

	const header = options.header
		? '<div class="rsx-head">' +
			`<a class="rsx-source" href="#" data-rsx-note="${escapeHtml(result.noteId)}" ` +
			`title="Open ${escapeHtml(sourceLabel(result))}">${escapeHtml(sourceLabel(result))}</a>` +
			(result.sectionTitle
				? `<span class="rsx-chip">${escapeHtml(result.sectionTitle)}</span>`
				: '<span class="rsx-chip rsx-chip-note">whole note</span>') +
			'</div>'
		: '';

	return `<div class="rsx-embed-inner">${header}<div class="rsx-body">${result.html}</div></div>`;
};

/** The class list of the outer element, so the viewer can swap states. */
export const embedClasses = (result: EmbedResult, options: EmbedOptions): string => {
	const out = [EMBED_CLASS, result.ok ? 'rsx-ready' : 'rsx-failed'];
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

	return `<div class="rsx-section${meta.unclosed ? ' rsx-section-unclosed' : ''}" data-rsx-section="${escapeHtml(meta.id)}">` +
		`<div class="rsx-section-tag">${name}</div>` +
		'<div class="rsx-section-body">';
};

export const sectionClose = (): string => '</div></div>';
