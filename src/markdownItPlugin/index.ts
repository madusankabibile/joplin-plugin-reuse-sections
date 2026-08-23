// Markdown-it content script.
//
// It handles both halves of the syntax:
//
//   * `&&& id` ... `/&&&` - a section of this note that other notes may reuse.
//     The content is tokenized as normal markdown and wrapped in a quiet
//     container, so the author can see what is shared and what is not.
//
//   * `&&&/notebook/note/#section` - content borrowed from another note. The
//     markdown for it comes from the plugin through a setting, which is the one
//     thing a rule can read synchronously; the borrowed text is then tokenized
//     into this note's own token stream, so every other markdown-it plugin
//     renders it exactly as it would in the note it came from.
//
// When the setting has nothing for a reference yet - the first time a note is
// opened, before the plugin has resolved it - an empty shell is left behind
// instead, and `embed.js` fills that in from the viewer. It is the same content
// either way; only the second route can call on other plugins.

import { parseCache } from '../reuse/cache';
import { isCloseFence, parseOpenFence, parseRefLine } from '../reuse/syntax';
import {
	EmbedMeta,
	SectionMeta,
	embedClose,
	embedColour,
	embedOpen,
	embedPlaceholder,
	referenceError,
	sectionClose,
	sectionOpen,
} from '../reuse/render';

/** How many levels of embedded-inside-embedded to follow before stopping. */
const MAX_EXPANSION_DEPTH = 3;

export default (_context: { contentScriptId: string }) => {
	return {
		plugin: (markdownIt: any, ruleOptions: any) => {
			// Joplin gives content scripts a synchronous reader for their own
			// settings. It is the only way for a rule to know anything the
			// plugin knows, so everything the viewer needs arrives this way.
			const settingValue = (key: string, fallback: any): any => {
				try {
					if (!ruleOptions || typeof ruleOptions.settingValue !== 'function') return fallback;
					const value = ruleOptions.settingValue(key);
					return value === undefined || value === null ? fallback : value;
				} catch (_error) {
					// The setting is not registered yet, or this version of
					// Joplin does not pass one in.
					return fallback;
				}
			};

			// Parsed once per change of the setting rather than once per render.
			let cacheText: string | null = null;
			let cache: Record<string, any> = {};

			const cachedEmbed = (raw: string) => {
				const current = String(settingValue('embedCache', ''));
				if (current !== cacheText) {
					cacheText = current;
					cache = parseCache(current);
				}
				return cache[raw] || null;
			};

			const lineAt = (state: any, line: number): string => {
				const start = state.bMarks[line] + state.tShift[line];
				return state.src.slice(start, state.eMarks[line]);
			};

			// ---------------------------------------------------------------
			// `&&&/...` - a reference to somebody else's content
			// ---------------------------------------------------------------

			// The references being expanded right now, innermost last, so a
			// section that reuses itself stops instead of filling the note.
			const expanding: string[] = [];

			const expand = (state: any, markdown: string) => {
				const text = String(markdown || '')
					.replace(/\r\n?/g, '\n')
					.replace(/\u0000/g, '\uFFFD');

				const first = state.tokens.length;
				const level = state.level;

				// The borrowed text joins this note's token stream, which is
				// what puts it through every other rule as well. Inline markup
				// is handled later, by the core chain, over all of these.
				state.md.block.parse(`${text}\n`, state.md, state.env, state.tokens);

				for (let i = first; i < state.tokens.length; i++) {
					// The line numbers belong to the other note, and Joplin uses
					// them to line the viewer up with the editor, so they go.
					state.tokens[i].map = null;
					// The nested parse counts levels from zero; these tokens sit
					// inside the embed this note is drawing.
					state.tokens[i].level += level;
				}
			};

			const referenceRule = (state: any, startLine: number, _endLine: number, silent: boolean): boolean => {
				if (state.sCount[startLine] - state.blkIndent >= 4) return false;

				const reference = parseRefLine(lineAt(state, startLine));
				if (!reference) return false;
				if (silent) return true;

				state.line = startLine + 1;

				const entry = cachedEmbed(reference.raw);

				// Not resolved yet: leave a shell for the viewer script.
				if (!entry) {
					const token = state.push('rsx_reference', 'div', 0);
					token.block = true;
					token.map = [startLine, startLine + 1];
					token.meta = reference;
					return true;
				}

				if (entry.error || expanding.length >= MAX_EXPANSION_DEPTH
					|| expanding.indexOf(reference.raw) !== -1) {
					const token = state.push('rsx_error', 'div', 0);
					token.block = true;
					token.map = [startLine, startLine + 1];
					token.meta = {
						raw: reference.raw,
						error: entry.error || 'Reused content is nested too deeply',
					};
					return true;
				}

				const meta: EmbedMeta = {
					raw: reference.raw,
					noteId: entry.noteId,
					noteTitle: entry.noteTitle,
					folderPath: entry.folderPath,
					sectionTitle: entry.sectionTitle,
					header: settingValue('showEmbedHeader', true) !== false,
					colour: embedColour(settingValue('embedColour', '')),
				};

				const open = state.push('rsx_embed_open', 'div', 1);
				open.block = true;
				open.map = [startLine, startLine + 1];
				open.meta = meta;

				expanding.push(reference.raw);
				try {
					expand(state, entry.markdown);
				} finally {
					expanding.pop();
				}

				const close = state.push('rsx_embed_close', 'div', -1);
				close.block = true;
				close.meta = meta;

				return true;
			};

			// ---------------------------------------------------------------
			// `&&& id` ... `/&&&` - a section other notes may reuse
			// ---------------------------------------------------------------

			const sectionRule = (state: any, startLine: number, endLine: number, silent: boolean): boolean => {
				if (state.sCount[startLine] - state.blkIndent >= 4) return false;

				const open = parseOpenFence(lineAt(state, startLine));
				if (!open) return false;
				if (silent) return true;

				// Sections are numbered across the whole note, so the name the
				// viewer shows for an unnamed one matches the reference the
				// picker writes for it.
				if (!state.env.rsxSectionCount) state.env.rsxSectionCount = 0;
				state.env.rsxSectionCount++;
				const index = state.env.rsxSectionCount;

				let nextLine = startLine;
				let depth = 1;
				let closed = false;

				while (nextLine + 1 < endLine) {
					nextLine += 1;
					if (state.sCount[nextLine] - state.blkIndent >= 4) continue;

					const text = lineAt(state, nextLine);
					if (parseOpenFence(text)) {
						depth += 1;
					} else if (isCloseFence(text)) {
						depth -= 1;
						if (depth === 0) {
							closed = true;
							break;
						}
					}
				}

				// A section that is still being typed runs to the end of the
				// note rather than disappearing from the preview.
				const contentEnd = closed ? nextLine : endLine;

				const meta: SectionMeta = {
					id: open.id || `section-${index}`,
					label: open.label,
					index,
					unclosed: !closed,
					hidden: settingValue('showSectionMarkers', true) === false,
					colour: embedColour(settingValue('embedColour', '')),
				};

				const oldParent = state.parentType;
				const oldLineMax = state.lineMax;
				state.parentType = 'rsx';
				state.lineMax = contentEnd;

				const tokenOpen = state.push('rsx_section_open', 'div', 1);
				tokenOpen.block = true;
				tokenOpen.markup = '&&&';
				tokenOpen.map = [startLine, contentEnd];
				tokenOpen.meta = meta;

				state.md.block.tokenize(state, startLine + 1, contentEnd);

				const tokenClose = state.push('rsx_section_close', 'div', -1);
				tokenClose.block = true;
				tokenClose.markup = '/&&&';

				state.parentType = oldParent;
				state.lineMax = oldLineMax;
				state.line = contentEnd + (closed ? 1 : 0);

				return true;
			};

			const alt = { alt: ['paragraph', 'reference', 'blockquote', 'list'] };
			markdownIt.block.ruler.before('fence', 'rsx_reference', referenceRule, alt);
			markdownIt.block.ruler.before('fence', 'rsx_section', sectionRule, alt);

			markdownIt.renderer.rules.rsx_reference = (tokens: any[], idx: number) =>
				embedPlaceholder(tokens[idx].meta.raw, 'Loading…');
			markdownIt.renderer.rules.rsx_error = (tokens: any[], idx: number) =>
				referenceError(tokens[idx].meta.raw, tokens[idx].meta.error);
			markdownIt.renderer.rules.rsx_embed_open = (tokens: any[], idx: number) =>
				embedOpen(tokens[idx].meta);
			markdownIt.renderer.rules.rsx_embed_close = () => embedClose();
			markdownIt.renderer.rules.rsx_section_open = (tokens: any[], idx: number) =>
				sectionOpen(tokens[idx].meta);
			markdownIt.renderer.rules.rsx_section_close = () => sectionClose();
		},

		assets: () => [
			{ name: './style.css' },
			{ name: './embed.js' },
		],
	};
};
