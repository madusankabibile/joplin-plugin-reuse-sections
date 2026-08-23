// Checks the parts of the plugin that can be checked without Joplin:
//
//   node tools/run-tests.js      (or: npm test)
//
// The fence and reference parsing, the section extraction, the renderer used
// for borrowed content, and - when `dist/` has been built - the markdown-it
// rules as the note viewer actually loads them.
//
// TypeScript is compiled to a throwaway directory inside the project, so the
// compiled modules resolve `markdown-it` from node_modules the way the plugin
// does.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, '.test-build');

let failed = 0;
let passed = 0;

const check = (label, ok, detail) => {
	if (ok) {
		passed++;
	} else {
		failed++;
		console.log(`FAIL ${label}${detail ? `
  ${detail}` : ''}`);
	}
};

const eq = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) {
		passed++;
	} else {
		failed++;
		console.log(`FAIL ${label}\n       got ${a}\n  expected ${b}`);
	}
};

// ---------------------------------------------------------------------------

// `resolve.ts` imports Joplin's `api` module, which only exists inside the app,
// so it is pointed at the fixtures in tools/test/fake-api.ts instead. That is
// what the generated tsconfig below is for: paths, and nothing else.
const compile = () => {
	fs.rmSync(buildDir, { recursive: true, force: true });
	fs.mkdirSync(buildDir, { recursive: true });

	fs.writeFileSync(path.join(buildDir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			outDir: '.',
			rootDir: '../',
			baseUrl: '../',
			module: 'commonjs',
			moduleResolution: 'node',
			target: 'es2019',
			lib: ['es2019', 'dom'],
			esModuleInterop: true,
			resolveJsonModule: true,
			skipLibCheck: true,
			paths: { api: ['tools/test/fake-api.ts'] },
		},
		files: [
			'../src/reuse/syntax.ts',
			'../src/reuse/markdown.ts',
			'../src/reuse/resolve.ts',
			'../tools/test/fake-api.ts',
		],
	}, null, '\t'));

	// The compiler is run through node rather than through `npx`, which needs a
	// shell on Windows and refuses to spawn without one.
	execFileSync(process.execPath, [
		path.join(root, 'node_modules/typescript/bin/tsc'),
		'-p', path.join(buildDir, 'tsconfig.json'),
	], { cwd: root, stdio: 'inherit' });
};

// The tsconfig above only tells the compiler where `api` is; the code it emits
// still says `require('api')`, so node is told the same thing here.
const Module = require('module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
	if (request === 'api') return path.join(buildDir, 'tools/test/fake-api.js');
	return resolveFilename.call(this, request, ...rest);
};

const required = name => require(path.join(buildDir, 'src/reuse', name));

// ---------------------------------------------------------------------------
// The syntax
// ---------------------------------------------------------------------------

const testSyntax = s => {
	eq('open fence: id and label',
		(() => { const o = s.parseOpenFence('&&& brain Grey matter'); return [o.id, o.label]; })(),
		['brain', 'Grey matter']);
	eq('open fence: bare',
		(() => { const o = s.parseOpenFence('&&&'); return [o.id, o.label]; })(), ['', '']);
	check('open fence is not a reference', s.parseOpenFence('&&&/anatomy/head') === null);
	check('open fence needs exactly three', s.parseOpenFence('&&&& x') === null);
	eq('close fence',
		[s.isCloseFence('/&&&'), s.isCloseFence('  /&&& '), s.isCloseFence('/&&& x')],
		[true, true, false]);

	const ref = s.parseRefLine('&&&/anatomy/head/#brain');
	eq('reference: notebook, note, section',
		[ref.folderPath, ref.noteTitle, ref.section, ref.noteId],
		[['anatomy'], 'head', 'brain', '']);
	eq('reference: whole note',
		(() => { const r = s.parseRefLine('&&&/anatomy/head'); return [r.folderPath, r.noteTitle, r.section]; })(),
		[['anatomy'], 'head', '']);
	eq('reference: nested notebooks',
		(() => { const r = s.parseRefLine('&&&/medicine/anatomy/head/#brain'); return [r.folderPath, r.noteTitle]; })(),
		[['medicine', 'anatomy'], 'head']);
	eq('reference: by note id',
		(() => {
			const r = s.parseRefLine('&&&/id/a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8/#brain');
			return [r.noteId, r.section, r.noteTitle];
		})(),
		['a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8', 'brain', '']);
	check('reference needs a target', s.parseRefLine('&&&/') === null);
	check('reference must be alone on its line', s.parseRefLine('see &&&/anatomy/head') === null);

	const written = s.formatReference({ folderPath: ['A/B'], noteTitle: 'head', section: 'brain' });
	eq('a slash in a title is escaped', written, '&&&/A\\/B/head/#brain');
	eq('and survives the round trip',
		(() => { const r = s.parseRefLine(written); return [r.folderPath, r.noteTitle, r.section]; })(),
		[['A/B'], 'head', 'brain']);
	eq('format by id', s.formatReference({ noteId: 'abc' }), '&&&/id/abc');

	// The drop-down needs to know where the segment being typed starts, and
	// what came before it, while the reference is still half written.
	eq('segments of a half-typed reference',
		s.referenceSegments('anatomy/head/'), ['anatomy', 'head', '']);
	eq('the segment being typed starts after the last separator',
		[s.lastSegmentStart('anatomy/he'), s.lastSegmentStart('anatomy/'), s.lastSegmentStart('ana')],
		[8, 8, 0]);
	eq('an escaped slash does not start a segment',
		s.lastSegmentStart('A\\/B/hea'), 5);

	const body = [
		'Intro paragraph', '',
		'&&& brain Grey matter', 'Brain content', '',
		'&&& stem', 'Stem content', '/&&&',
		'/&&&', '',
		'&&&', 'Unnamed content', '/&&&', '',
		'&&& open-ended', 'Runs to the end',
	].join('\n');

	const sections = s.extractSections(body);
	eq('section ids', sections.map(x => x.id), ['brain', 'stem', 'section-3', 'open-ended']);
	eq('section labels', sections.map(x => x.label), ['Grey matter', '', '', '']);
	eq('an outer section keeps the inner one, without its fences',
		sections[0].content, 'Brain content\n\nStem content');
	eq('an inner section stands on its own', sections[1].content, 'Stem content');
	eq('an unclosed section runs to the end of the note',
		[sections[3].content, sections[3].unclosed], ['Runs to the end', true]);

	eq('found by id', s.findSection(sections, 'BRAIN').id, 'brain');
	eq('found by label', s.findSection(sections, 'grey matter').id, 'brain');
	eq('found by position', s.findSection(sections, '2').id, 'stem');
	check('not found', s.findSection(sections, 'nope') === null);

	eq('a whole note drops its fences', s.stripFences('&&& a\nOne\n/&&&\n\nTwo'), 'One\n\nTwo');
	eq('summary', s.summarise('# Title\n\nSome **bold** text'), 'Title Some bold text');
};

// ---------------------------------------------------------------------------
// The renderer used for borrowed content
// ---------------------------------------------------------------------------

const testMarkdown = m => {
	eq('collects the ids a note refers to',
		m.collectItemIds('![x](:/aaaabbbbccccddddaaaabbbbccccdddd) [y](:/1111222233334444)'),
		['aaaabbbbccccddddaaaabbbbccccdddd', '1111222233334444']);

	const html = m.renderMarkdown([
		'![x](:/aaaabbbbccccddddaaaabbbbccccdddd)', '',
		'[y](:/1111222233334444)', '',
		'[gone](:/9999888877776666)', '',
		'| a | b |', '| - | - |', '| 1 | 2 |', '',
		'<b onclick="alert(1)">html kept, handler gone</b>', '',
		'<script>alert(2)</script>',
	].join('\n'), {
		resources: { aaaabbbbccccddddaaaabbbbccccdddd: 'file:///C:/res/a.png' },
		notes: { '1111222233334444': true },
	});

	check('an attachment becomes a URL the viewer can load',
		html.includes('src="file:///C:/res/a.png"'));
	check('a link to a note is handed to the viewer script',
		html.includes('data-rsx-note="1111222233334444"'));
	check('an id that is neither is left alone', html.includes('href=":/9999888877776666"'));
	check('tables render', html.includes('<table>'));
	check('inline html survives', html.includes('<b>html kept'));
	check('event handlers are stripped', !/onclick/i.test(html));
	check('scripts are stripped', !/alert\(2\)/.test(html));
	check('a missing attachment is named, not broken',
		m.renderMarkdown('![alt](:/ffffeeeeddddccccffffeeeeddddcccc)', m.emptyContext())
			.includes('rsx-missing'));
};

// ---------------------------------------------------------------------------
// The markdown-it rules, as the viewer loads them
// ---------------------------------------------------------------------------

const testViewer = () => {
	const bundle = path.join(root, 'dist/markdownItPlugin/index.js');
	if (!fs.existsSync(bundle)) {
		console.log('  (skipping the viewer rules: run `npm run dist` first)');
		return;
	}

	const MarkdownIt = require(path.join(root, 'node_modules/markdown-it'));
	const loaded = require(bundle);

	const script = (loaded.default || loaded)({ contentScriptId: 'test' });

	const md = new MarkdownIt({ html: true });
	md.use(script.plugin);

	const html = md.render([
		'&&& brain Grey matter',
		'The **brain** sits inside the skull.',
		'/&&&', '',
		'&&&/anatomy/head/#brain', '',
		'Not a reference: see &&&/inline/thing here.', '',
		'&&&', 'An unnamed section.', '/&&&',
	].join('\n'));

	check('a section becomes a container',
		html.includes('class="rsx-section" data-rsx-section="brain"'));
	check('its label is shown', html.includes('rsx-section-label">Grey matter'));
	check('its contents are still markdown', html.includes('<strong>brain</strong>'));
	check('a reference becomes a placeholder for the viewer script',
		html.includes('data-rsx-ref="anatomy/head/#brain"'));
	check('a reference mid-sentence is left alone',
		html.includes('see &amp;&amp;&amp;/inline/thing here'));
	check('an unnamed section is numbered', html.includes('data-rsx-section="section-2"'));
	eq('the viewer script and stylesheet are declared',
		script.assets(), [{ name: './style.css' }, { name: './embed.js' }]);

	// ---------------------------------------------------------------------
	// The point of the whole exercise: content borrowed from another note is
	// tokenized into this one, so every other markdown-it plugin renders it.
	// ---------------------------------------------------------------------

	const cache = {
		version: 1,
		entries: {
			'Anatomy/Head/#brain': {
				markdown: [
					'!!! checklist_boxed Checklist',
					'[x] Done item',
					'[ ] Pending item',
					'!!!->',
					'',
					'And **bold** text.',
				].join('\n'),
				noteId: 'n-head',
				noteTitle: 'Head',
				folderPath: ['Medicine', 'Anatomy'],
				sectionTitle: 'Grey matter',
			},
			'Anatomy/Gone': { markdown: '', noteId: '', noteTitle: '', folderPath: [], sectionTitle: '', error: 'No note called "Gone"' },
		},
	};

	const withCache = new MarkdownIt({ html: true });

	// Stands in for another plugin - HTML Blocks, say - with a rule of its own
	// on the same markdown-it instance.
	withCache.block.ruler.before('fence', 'other_plugin', (state, startLine, endLine, silent) => {
		const start = state.bMarks[startLine] + state.tShift[startLine];
		if (!/^!!! /.test(state.src.slice(start, state.eMarks[startLine]))) return false;
		if (silent) return true;

		let line = startLine;
		while (line + 1 < endLine) {
			line += 1;
			const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
			if (text.trim() === '!!!->') break;
		}

		const token = state.push('other_plugin', 'div', 0);
		token.block = true;
		state.line = line + 1;
		return true;
	}, { alt: ['paragraph'] });
	withCache.renderer.rules.other_plugin = () => '<div class="other-plugin">a real block</div>';

	withCache.use((script.plugin), {
		settingValue: key => (key === 'embedCache' ? JSON.stringify(cache) : undefined),
	});

	const embedded = withCache.render([
		'Before.',
		'',
		'&&&/Anatomy/Head/#brain',
		'',
		'&&&/Anatomy/Gone',
		'',
		'&&&/Anatomy/Never seen',
	].join('\n'));

	check("another plugin's rule runs on borrowed content",
		embedded.includes('<div class="other-plugin">'), embedded);
	check('and its markup is not left as text', !embedded.includes('!!! checklist_boxed'), embedded);
	check('ordinary markdown in the same section renders too',
		embedded.includes('<strong>bold</strong>'), embedded);
	check('the source of the content is named',
		embedded.includes('Medicine / Anatomy / Head') && embedded.includes('Grey matter'), embedded);
	check('a reference that resolves to nothing says so',
		embedded.includes('No note called &quot;Gone&quot;'), embedded);
	check('one the plugin has not seen yet waits for the viewer',
		embedded.includes('data-rsx-ref="Anatomy/Never seen"'), embedded);
};

// ---------------------------------------------------------------------------
// The drop-down that opens as a reference is typed
// ---------------------------------------------------------------------------

const labels = reply => reply.options.map(option => option.label);
const option = (reply, label) => reply.options.find(o => o.label === label);

const testCompletion = async r => {
	// `&&&/` - anything you might start from.
	const top = await r.completeReference('');
	eq('nothing has been typed to replace yet', top.from, 0);
	check('every notebook is offered',
		['Medicine', 'Anatomy', 'Pharmacology', 'Recipes'].every(t => !!option(top, t)));
	eq('a notebook inside another inserts the whole path',
		option(top, 'Anatomy').insert, 'Medicine/Anatomy/');
	check('and says there is more to come', option(top, 'Anatomy').continues);
	check('recently edited notes are offered as a short cut', !!option(top, 'Head'));
	eq('a note there inserts its whole path',
		option(top, 'Head').insert, 'Medicine/Anatomy/Head');
	check('and ends the reference', !option(top, 'Head').continues);

	eq('what has been typed of a segment is what gets replaced',
		(await r.completeReference('Med')).from, 3);

	// Inside a notebook: the notebooks in it, then its notes.
	const inside = await r.completeReference('Medicine/');
	eq('the notebooks within it', labels(inside), ['Anatomy', 'Pharmacology']);
	eq('inserted by name, since the path is already there',
		inside.options[0].insert, 'Anatomy/');

	eq('and the notes of a notebook that has them',
		labels(await r.completeReference('Medicine/Anatomy/')),
		['Head', 'Neck and shoulders', 'Thorax']);
	eq('a shortened notebook path still resolves',
		labels(await r.completeReference('Anatomy/')),
		['Head', 'Neck and shoulders', 'Thorax']);

	// After a note: what can be taken from it.
	const sections = await r.completeReference('Anatomy/Head/');
	eq('the sections of the note, unnamed ones included',
		labels(sections), ['#brain', '#stem', '#section-3']);
	eq('described by their label', option(sections, '#brain').detail, 'Grey matter');
	eq('and inserted as #id', option(sections, '#brain').insert, '#brain');

	const typed = await r.completeReference('Anatomy/Head/#br');
	eq('a typed #br is replaced whole', typed.from, 3);
	eq('and still filters the sections', labels(typed), ['#brain', '#stem', '#section-3']);

	eq('a note with no sections offers nothing',
		(await r.completeReference('Anatomy/Neck and shoulders/')).options, []);
	eq('and neither does a path that leads nowhere',
		(await r.completeReference('Nowhere/Nothing/')).options, []);
};

// ---------------------------------------------------------------------------
// Turning a reference into content
// ---------------------------------------------------------------------------

const testResolve = async r => {
	const reference = (noteTitle, section, folderPath = ['Anatomy']) =>
		({ folderPath, noteTitle, noteId: '', section, raw: `${noteTitle}/${section}` });

	const section = await r.resolveEmbed(reference('Head', 'brain'));
	check('a section resolves', section.ok, section.error);
	eq('to the note it came from',
		[section.noteTitle, section.folderPath, section.sectionTitle],
		['Head', ['Medicine', 'Anatomy'], 'Grey matter']);
	// How it is turned into HTML is the subject of testRenderPath below; here
	// it only matters that the right content got that far.
	check('carrying the content of that section',
		section.html.includes('The **brain** sits inside the skull.'), section.html);

	const whole = await r.resolveEmbed(reference('Head', ''));
	check('a whole note keeps its content', whole.html.includes('An unnamed part'));
	check('and loses its fences', !whole.html.includes('&amp;&amp;&amp;'));

	const nested = await r.resolveEmbed(reference('Dosages', 'adult', ['Pharmacology']));
	check('a section that reuses another brings it along',
		nested.ok && nested.html.includes('spinal cord'), nested.html);

	const missingNote = await r.resolveEmbed(reference('Foot', ''));
	eq('a missing note says so',
		[missingNote.ok, missingNote.error], [false, 'No note called "Foot"']);

	const missingSection = await r.resolveEmbed(reference('Head', 'toes'));
	eq('a missing section says which note it looked in',
		[missingSection.ok, missingSection.error],
		[false, '"Head" has no section called "toes"']);
};

// ---------------------------------------------------------------------------
// Rendering through Joplin, so other plugins' markup comes through as markup
// ---------------------------------------------------------------------------

const testRenderPath = async (r, fake) => {
	const reference = { folderPath: ['Anatomy'], noteTitle: 'Head', noteId: '', section: 'brain', raw: 'render-check' };

	r.clearEmbedCache();
	const viaJoplin = await r.resolveEmbed(reference);
	check("Joplin's own renderer is used when it is there",
		viaJoplin.html.includes('joplin-rendered'), viaJoplin.html);
	check('the markup reaches it unrendered, for its rules to handle',
		viaJoplin.html.includes('The **brain** sits inside the skull.'), viaJoplin.html);
	check('resources are handed over so images can be drawn',
		!!fake.app.lastRenderOptions && !!fake.app.lastRenderOptions.resources);
	check('and only the body is asked for', fake.app.lastRenderOptions.bodyOnly === true);

	eq('stylesheets the note may lack are passed on',
		viaJoplin.assets.map(asset => asset.name), ['katex/katex.css']);
	eq('inline css too', viaJoplin.css, ['.joplin-rendered { color: inherit; }']);

	// Older Joplin, without the command.
	fake.app.hasRenderMarkup = false;
	r.clearEmbedCache();
	const fallback = await r.resolveEmbed({ ...reference, raw: 'fallback-check' });
	check('the plugin renders it itself when the command is missing',
		fallback.ok && fallback.html.includes('<strong>brain</strong>'), fallback.html);
	eq('and asks for no stylesheets', [fallback.assets, fallback.css], [[], []]);
	fake.app.hasRenderMarkup = true;
};

// ---------------------------------------------------------------------------

compile();

(async () => {
	try {
		testSyntax(required('syntax.js'));
		testMarkdown(required('markdown.js'));
		testViewer();

		const resolve = required('resolve.js');
		await testCompletion(resolve);
		await testResolve(resolve);
		await testRenderPath(resolve, require(path.join(buildDir, 'tools/test/fake-api.js')));
	} finally {
		fs.rmSync(buildDir, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
