// Markdown-it content script.
//
// It handles both halves of the syntax:
//
//   * `&&& id` ... `/&&&` - a section of this note that other notes may reuse.
//     The content is tokenized as normal markdown and wrapped in a quiet
//     container, so the author can see what is shared and what is not.
//
//   * `&&&/notebook/note/#section` - content borrowed from another note. All
//     that can be emitted here is an empty shell: reading another note is
//     asynchronous, and a markdown-it rule is not. `embed.js` fills the shell
//     in from the viewer, where waiting is allowed.

import { isCloseFence, parseOpenFence, parseRefLine } from '../reuse/syntax';
import {
	SectionMeta,
	embedPlaceholder,
	sectionClose,
	sectionOpen,
} from '../reuse/render';

export default (_context: { contentScriptId: string }) => {
	return {
		plugin: (markdownIt: any) => {
			const lineAt = (state: any, line: number): string => {
				const start = state.bMarks[line] + state.tShift[line];
				return state.src.slice(start, state.eMarks[line]);
			};

			// ---------------------------------------------------------------
			// `&&&/...` - a reference to somebody else's content
			// ---------------------------------------------------------------

			const referenceRule = (state: any, startLine: number, _endLine: number, silent: boolean): boolean => {
				if (state.sCount[startLine] - state.blkIndent >= 4) return false;

				const reference = parseRefLine(lineAt(state, startLine));
				if (!reference) return false;
				if (silent) return true;

				const token = state.push('rsx_reference', 'div', 0);
				token.block = true;
				token.map = [startLine, startLine + 1];
				token.meta = reference;

				state.line = startLine + 1;
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
