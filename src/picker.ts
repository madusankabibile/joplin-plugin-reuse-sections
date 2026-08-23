// The "reuse a section" picker.
//
// Joplin dialogs cannot talk back to the plugin while they are open, so the
// three steps - notebook, note, section - are three openings of the same
// dialog, each one built here from data the plugin has already fetched. That is
// also why "Back" is a dialog button rather than something the page handles:
// going back means the plugin loading the previous step again.

import { FolderEntry, NoteEntry, SectionEntry } from './reuse/types';
import { escapeHtml } from './reuse/render';

/** The pseudo notebook that lists whatever was edited last. */
export const RECENT_ID = '__recent';

interface Row {
	id: string;
	title: string;
	/** The dimmer second line: a notebook path, a preview, a count. */
	sub?: string;
	/** Small monospace tag on the right. */
	tag?: string;
	/** Extra words the filter should match on. */
	terms?: string;
	depth?: number;
	className?: string;
}

interface StepOptions {
	step: 1 | 2 | 3;
	heading: string;
	/** Where the user is, shown under the heading. */
	crumb: string;
	placeholder: string;
	hint: string;
	rows: Row[];
	empty: string;
	/** Preselected row id. Defaults to the first row. */
	selected?: string;
}

const rowHtml = (row: Row, selected: boolean): string => {
	const depth = Math.min(row.depth || 0, 6);

	return `<button type="button" class="row${selected ? ' selected' : ''}${row.className ? ` ${row.className}` : ''}"
			data-id="${escapeHtml(row.id)}"
			data-search="${escapeHtml(`${row.title} ${row.sub || ''} ${row.terms || ''}`.toLowerCase())}"
			style="--depth:${depth}">
		<span class="row-main">
			<span class="row-title">${escapeHtml(row.title)}</span>
			${row.sub ? `<span class="row-sub">${escapeHtml(row.sub)}</span>` : ''}
		</span>
		${row.tag ? `<span class="row-tag">${escapeHtml(row.tag)}</span>` : ''}
	</button>`;
};

const stepHtml = (options: StepOptions): string => {
	const selected = options.selected || (options.rows.length ? options.rows[0].id : '');
	const rows = options.rows
		.map(row => rowHtml(row, row.id === selected))
		.join('');

	return `
		<form name="pickerForm" id="rsx-picker" class="step-${options.step}">
			<header class="picker-head">
				<div class="picker-steps">
					<span class="step${options.step >= 1 ? ' done' : ''}">Notebook</span>
					<span class="step${options.step >= 2 ? ' done' : ''}">Note</span>
					<span class="step${options.step >= 3 ? ' done' : ''}">Section</span>
				</div>
				<h2>${escapeHtml(options.heading)}</h2>
				${options.crumb ? `<p class="crumb">${escapeHtml(options.crumb)}</p>` : ''}
				<input type="text" id="rsx-search" placeholder="${escapeHtml(options.placeholder)}" autocomplete="off">
			</header>

			<div class="picker-body">
				<div id="rsx-list">
					${rows || `<p class="empty">${escapeHtml(options.empty)}</p>`}
					<p id="rsx-empty" class="empty hidden">Nothing matches that filter.</p>
				</div>
			</div>

			<footer class="picker-foot">
				<input type="hidden" name="choice" id="rsx-choice" value="${escapeHtml(selected)}">
				<span class="hint">${escapeHtml(options.hint)}</span>
			</footer>
		</form>`;
};

// ---------------------------------------------------------------------------
// Step 1: which notebook
// ---------------------------------------------------------------------------

export const folderStepHtml = (folders: FolderEntry[], recent: number): string => {
	const rows: Row[] = [
		{
			id: RECENT_ID,
			title: 'Recently edited notes',
			sub: `The last ${recent} notes you worked on, from any notebook`,
			className: 'row-recent',
		},
		...folders.map(folder => ({
			id: folder.id,
			title: folder.title || '(Untitled)',
			sub: folder.path.length > 1 ? folder.path.slice(0, -1).join(' / ') : '',
			terms: folder.path.join(' '),
			depth: folder.depth,
		})),
	];

	return stepHtml({
		step: 1,
		heading: 'Reuse content from…',
		crumb: '',
		placeholder: 'Filter notebooks…',
		hint: 'Pick the notebook the content lives in.',
		empty: 'There are no notebooks yet.',
		rows,
	});
};

// ---------------------------------------------------------------------------
// Step 2: which note
// ---------------------------------------------------------------------------

export const noteStepHtml = (notes: NoteEntry[], where: string, showPaths: boolean): string => {
	const rows: Row[] = notes.map(note => ({
		id: note.id,
		title: note.title || '(Untitled)',
		sub: showPaths ? note.folderPath.join(' / ') : '',
		terms: note.folderPath.join(' '),
	}));

	return stepHtml({
		step: 2,
		heading: 'Which note?',
		crumb: where,
		placeholder: 'Filter notes…',
		hint: 'Pick a note. If it has shareable sections you can choose one next.',
		empty: 'This notebook has no notes.',
		rows,
	});
};

// ---------------------------------------------------------------------------
// Step 3: the whole note, or one of its sections
// ---------------------------------------------------------------------------

export const sectionStepHtml = (note: NoteEntry, sections: SectionEntry[]): string => {
	const rows: Row[] = [
		{
			id: '',
			title: 'The whole note',
			sub: 'Everything in the note, minus the section markers themselves',
			className: 'row-whole',
		},
		...sections.map(section => ({
			id: section.id,
			title: section.title,
			sub: section.preview || '(empty)',
			tag: `#${section.id}`,
			terms: `${section.id} section ${section.index}`,
		})),
	];

	return stepHtml({
		step: 3,
		heading: sections.length ? 'Which part?' : 'Reuse this note',
		crumb: [...note.folderPath, note.title].join(' / '),
		placeholder: 'Filter sections…',
		hint: sections.length
			? 'Pick a section, or take the whole note.'
			: 'This note has no &&& sections yet, so the whole note will be reused.',
		empty: 'This note has no sections.',
		rows,
	});
};
