// The syntax, in one place, so the editor, the viewer and the picker can never
// disagree about what is a section and what is a reference.
//
// A shareable section is fenced in the note that owns it:
//
//     &&& brain Grey matter
//     Anything markdown here.
//     /&&&
//
// The word after `&&&` is the section id used to link to it; the rest of the
// line is an optional label. Both may be left out, in which case the section is
// known by its position - `section-1`, `section-2`, and so on.
//
// A reference is a line of its own in the note that reuses the content:
//
//     &&&/anatomy/head/#brain      a section of a note
//     &&&/anatomy/head             a whole note
//     &&&/id/a1b2.../#brain        the same, pinned to a note id
//
// `&&&` never means "reference" and `&&&/` never means "section", so a line can
// always be classified without looking at the lines around it.

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

/** `&&& id Label` - the `(?![&/])` is what keeps `&&&/...` out of here. */
export const OPEN_RE = /^(\s{0,3})(&&&)(?![&/])[ \t]*([A-Za-z0-9][A-Za-z0-9_-]*)?[ \t]*(.*)$/;

/** `/&&&` - the closing fence takes nothing else on the line. */
export const CLOSE_RE = /^\s{0,3}(\/&&&)[ \t]*$/;

/** `&&&/notebook/note/#section` on a line of its own. */
export const REF_RE = /^(\s{0,3})(&&&\/)([^\s].*?)[ \t]*$/;

export interface OpenFence {
	/** The explicit section id, or '' when the fence is just `&&&`. */
	id: string;
	label: string;
	/** Offsets within the line, for the editor decorations. */
	markerStart: number;
	markerEnd: number;
	idStart: number;
	idEnd: number;
	labelStart: number;
}

export const parseOpenFence = (line: string): OpenFence | null => {
	const m = OPEN_RE.exec(line);
	if (!m) return null;

	const markerStart = m[1].length;
	const markerEnd = markerStart + m[2].length;
	const id = m[3] || '';
	const idStart = id ? line.indexOf(id, markerEnd) : markerEnd;
	const idEnd = idStart + id.length;
	const label = (m[4] || '').trim();

	return {
		id,
		label,
		markerStart,
		markerEnd,
		idStart,
		idEnd,
		labelStart: label ? line.indexOf(label, idEnd) : idEnd,
	};
};

export const isCloseFence = (line: string): boolean => CLOSE_RE.test(line);

/** True for either fence - the lines that are markup rather than content. */
export const isFenceLine = (line: string): boolean =>
	isCloseFence(line) || !!OPEN_RE.exec(line);

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export interface Reference {
	/** Notebook names, outermost first. Empty for an id reference. */
	folderPath: string[];
	/** The note title. Empty for an id reference. */
	noteTitle: string;
	/** A note id, when the reference was written as `&&&/id/...`. */
	noteId: string;
	/** The section id, or '' for the whole note. */
	section: string;
	/** The reference as it was written, without the `&&&/` marker. */
	raw: string;
}

export interface RefLine extends Reference {
	markerStart: number;
	markerEnd: number;
	bodyStart: number;
}

const NOTE_ID_RE = /^[0-9a-fA-F]{16,64}$/;

/** `/` is the separator, so a `/` inside a title travels as `\/`. */
export const escapeSegment = (text: string): string =>
	String(text).replace(/\\/g, '\\\\').replace(/\//g, '\\/').trim();

const unescapeSegment = (text: string): string =>
	text.replace(/\\(.)/g, '$1').trim();

/** Splits on unescaped slashes only. */
const splitSegments = (rest: string): string[] => {
	const out: string[] = [];
	let current = '';

	for (let i = 0; i < rest.length; i++) {
		const char = rest[i];
		if (char === '\\' && i + 1 < rest.length) {
			current += char + rest[i + 1];
			i++;
		} else if (char === '/') {
			out.push(current);
			current = '';
		} else {
			current += char;
		}
	}

	out.push(current);
	return out;
};

/**
 * The segments of a reference that is still being typed - empty ones included,
 * because a trailing `/` is exactly what says "now show me what is in there".
 */
export const referenceSegments = (rest: string): string[] =>
	splitSegments(rest).map(unescapeSegment);

/** Where the segment currently being typed starts within `rest`. */
export const lastSegmentStart = (rest: string): number => {
	for (let i = rest.length - 1; i >= 0; i--) {
		if (rest[i] !== '/') continue;
		// An escaped slash is part of a title, not a separator.
		let backslashes = 0;
		while (i - 1 - backslashes >= 0 && rest[i - 1 - backslashes] === '\\') backslashes++;
		if (backslashes % 2 === 0) return i + 1;
	}
	return 0;
};

/** Parses everything after `&&&/`. Returns null when there is nothing usable. */
export const parseReference = (rest: string): Reference | null => {
	const trimmed = rest.trim();
	if (!trimmed) return null;

	const segments = splitSegments(trimmed).map(unescapeSegment).filter(part => part !== '');
	if (!segments.length) return null;

	let section = '';
	if (segments[segments.length - 1].startsWith('#')) {
		section = segments.pop().slice(1).trim();
	}

	// `&&&/id/<note id>` - unreadable, but survives renames and moves.
	if (segments.length === 2 && segments[0].toLowerCase() === 'id' && NOTE_ID_RE.test(segments[1])) {
		return { folderPath: [], noteTitle: '', noteId: segments[1], section, raw: trimmed };
	}

	if (!segments.length) return null;

	return {
		folderPath: segments.slice(0, -1),
		noteTitle: segments[segments.length - 1],
		noteId: '',
		section,
		raw: trimmed,
	};
};

export const parseRefLine = (line: string): RefLine | null => {
	const m = REF_RE.exec(line);
	if (!m) return null;

	const reference = parseReference(m[3]);
	if (!reference) return null;

	const markerStart = m[1].length;
	return {
		...reference,
		markerStart,
		markerEnd: markerStart + m[2].length,
		bodyStart: markerStart + m[2].length,
	};
};

export interface RefParts {
	folderPath?: string[];
	noteTitle?: string;
	noteId?: string;
	section?: string;
}

/** Builds the text of a reference, `&&&/` marker included. */
export const formatReference = (parts: RefParts): string => {
	const segments = parts.noteId
		? ['id', parts.noteId]
		: [...(parts.folderPath || []), parts.noteTitle || ''].map(escapeSegment);

	if (parts.section) segments.push(`#${escapeSegment(parts.section)}`);
	return `&&&/${segments.filter(part => part !== '').join('/')}`;
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface NoteSection {
	/** The id used in references - explicit, or `section-N`. */
	id: string;
	/** The explicit id as it was typed, or '' when there was none. */
	explicitId: string;
	label: string;
	/** 1 based position within the note, so `#2` works as an id too. */
	index: number;
	/** Line numbers, 0 based, of the fences themselves. */
	startLine: number;
	endLine: number;
	/** The markdown between the fences, with all fence lines removed. */
	content: string;
	/** The fence was never closed, so the section runs to the end of the note. */
	unclosed: boolean;
}

interface OpenSection {
	id: string;
	explicitId: string;
	label: string;
	index: number;
	startLine: number;
	lines: string[];
}

/**
 * Every shareable section of a note, in the order they open. Sections may be
 * nested: an inner one is listed in its own right, and its content also forms
 * part of the section that contains it.
 */
export const extractSections = (body: string): NoteSection[] => {
	const lines = String(body || '').split(/\r?\n/);
	const out: NoteSection[] = [];
	const stack: OpenSection[] = [];
	let opened = 0;

	const finish = (open: OpenSection, endLine: number, unclosed: boolean) => {
		out.push({
			id: open.id,
			explicitId: open.explicitId,
			label: open.label,
			index: open.index,
			startLine: open.startLine,
			endLine,
			content: trimBlankEdges(open.lines).join('\n'),
			unclosed,
		});
	};

	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		const open = parseOpenFence(text);

		if (open) {
			opened++;
			stack.push({
				id: open.id || `section-${opened}`,
				explicitId: open.id,
				label: open.label,
				index: opened,
				startLine: line,
				lines: [],
			});
			continue;
		}

		if (isCloseFence(text)) {
			// A stray `/&&&` is content rather than markup: with nothing open
			// there is no section for it to close.
			if (stack.length) {
				finish(stack.pop(), line, false);
				continue;
			}
		}

		for (const section of stack) section.lines.push(text);
	}

	// Sections left open run to the end of the note, which keeps the preview
	// working while the fence is still being typed.
	while (stack.length) finish(stack.pop(), lines.length - 1, true);

	out.sort((a, b) => a.index - b.index);
	return out;
};

/** The whole note, minus the fence lines, for a reference with no `#section`. */
export const stripFences = (body: string): string => {
	const kept = String(body || '')
		.split(/\r?\n/)
		.filter(line => !isFenceLine(line));
	return trimBlankEdges(kept).join('\n');
};

/** Finds the section a reference asks for: by id, then by position. */
export const findSection = (sections: NoteSection[], wanted: string): NoteSection | null => {
	const needle = String(wanted || '').trim().toLowerCase();
	if (!needle) return null;

	const byId = sections.find(section => section.id.toLowerCase() === needle);
	if (byId) return byId;

	const byLabel = sections.find(section => section.label.toLowerCase() === needle);
	if (byLabel) return byLabel;

	if (/^\d+$/.test(needle)) {
		const byIndex = sections.find(section => section.index === Number(needle));
		if (byIndex) return byIndex;
	}

	return null;
};

/** What the picker and the section list show for a section. */
export const sectionTitle = (section: NoteSection): string =>
	section.label || section.explicitId || `Section ${section.index}`;

const trimBlankEdges = (lines: string[]): string[] => {
	let start = 0;
	let end = lines.length;
	while (start < end && !lines[start].trim()) start++;
	while (end > start && !lines[end - 1].trim()) end--;
	return lines.slice(start, end);
};

/** A one line summary of some markdown, for the picker and the embed header. */
export const summarise = (markdown: string, limit = 120): string => {
	const text = String(markdown || '')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/[*_`>[\]]/g, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
