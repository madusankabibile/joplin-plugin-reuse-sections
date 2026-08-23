// Viewer side of an embed.
//
// The markdown-it rule leaves an empty `.rsx-embed` in the note; this fills it
// in. It runs inside the note viewer, where `webviewApi.postMessage` can reach
// the plugin - and therefore the other note - which a markdown-it rule cannot.
//
// Joplin swaps the viewer's content on every render and loads this file again,
// so all of the state lives on `window` and every listener is bound once.

(function() {
	// Must match CONTENT_SCRIPT_ID in ../index.ts.
	var SCRIPT_ID = 'com.madusanka.reuseSections.markdownIt';

	// How often to ask whether a source note has changed, in ms.
	var POLL_INTERVAL = 2500;

	if (typeof webviewApi === 'undefined' || !webviewApi.postMessage) return;

	var state = window.__rsxState;
	if (!state) {
		state = window.__rsxState = {
			settings: null,
			revision: 0,
			timer: null,
			bound: false,
			pending: false,
		};
	}

	function post(message) {
		try {
			return Promise.resolve(webviewApi.postMessage(SCRIPT_ID, message));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	function embeds() {
		return Array.prototype.slice.call(document.querySelectorAll('.rsx-embed[data-rsx-ref]'));
	}

	// Borrowed content is drawn by Joplin's own renderer, so it may need a
	// stylesheet this note has not loaded - KaTeX's, for one, which Joplin
	// leaves out of a note that has no maths of its own.
	function addStyles(response) {
		var assets = response.assets || [];
		var head = document.head || document.documentElement;

		for (var i = 0; i < assets.length; i++) {
			var asset = assets[i];
			var href = asset.pathIsAbsolute
				? 'file:///' + String(asset.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
				: 'pluginAssets/' + asset.name;

			if (document.querySelector('link[href="' + href + '"]')) continue;
			// Joplin's own assets are already here under the same href, so this
			// only ever adds what is missing.
			var link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = href;
			link.setAttribute('data-rsx-asset', asset.name || '');
			head.appendChild(link);
		}

		var css = response.css || [];
		for (var c = 0; c < css.length; c++) {
			var key = 'rsx-css-' + hash(css[c]);
			if (document.getElementById(key)) continue;
			var style = document.createElement('style');
			style.id = key;
			style.textContent = css[c];
			head.appendChild(style);
		}
	}

	function hash(text) {
		var value = 0;
		for (var i = 0; i < text.length; i++) {
			value = ((value << 5) - value + text.charCodeAt(i)) | 0;
		}
		return String(value >>> 0);
	}

	function fill(element, response) {
		if (!response) return;
		addStyles(response);
		element.className = response.classes || 'rsx-embed rsx-failed';
		element.innerHTML = response.html || '';
		element.setAttribute('data-rsx-state', 'ready');
		element.setAttribute('data-rsx-revision', String(response.revision || 0));
		if (response.revision) state.revision = response.revision;
	}

	/** How many embeds this one sits inside, so a loop cannot run away. */
	function depthOf(element) {
		var depth = 0;
		var node = element.parentNode;
		while (node && node !== document) {
			if (node.nodeType === 1 && node.classList && node.classList.contains('rsx-embed')) depth++;
			node = node.parentNode;
		}
		return depth;
	}

	function load(element, force) {
		var ref = element.getAttribute('data-rsx-ref');
		if (!ref) return;

		var status = element.getAttribute('data-rsx-state');
		if (!force && (status === 'ready' || status === 'loading')) return;

		// Content pulled in by Joplin's renderer can itself contain a
		// reference, which is how nesting works - but only so far.
		if (depthOf(element) >= 3) {
			element.setAttribute('data-rsx-state', 'ready');
			element.className = 'rsx-embed rsx-failed';
			element.innerHTML = '<div class="rsx-embed-inner"><div class="rsx-error">' +
				'<span class="rsx-error-title">Reused content is nested too deeply</span>' +
				'<code class="rsx-error-ref">&amp;&amp;&amp;/' + ref + '</code></div></div>';
			return;
		}

		element.setAttribute('data-rsx-state', 'loading');

		post({ type: 'embed', ref: ref }).then(function(response) {
			fill(element, response);
		}).catch(function(error) {
			element.setAttribute('data-rsx-state', 'ready');
			element.className = 'rsx-embed rsx-failed';
			element.innerHTML = '<div class="rsx-embed-inner"><div class="rsx-error">' +
				'<span class="rsx-error-title">Could not reach the plugin</span>' +
				'<code class="rsx-error-ref">' + String(error && error.message || error) + '</code>' +
				'</div></div>';
		});
	}

	// The settings decide whether the source line is drawn and whether the
	// author's own section markers are visible, both of which are pure CSS -
	// so a change never needs the note to be rendered again.
	function applySettings(settings) {
		state.settings = settings || {};
		var root = document.documentElement;
		if (!root) return;
		root.classList.toggle('rsx-hide-sections', settings && settings.showSectionMarkers === false);
	}

	function poll() {
		if (state.timer) {
			clearInterval(state.timer);
			state.timer = null;
		}
		if (!state.settings || state.settings.liveUpdate === false) return;
		if (!embeds().length) return;

		state.timer = setInterval(function() {
			if (document.hidden) return;
			var list = embeds();
			if (!list.length) {
				clearInterval(state.timer);
				state.timer = null;
				return;
			}

			post({ type: 'revision' }).then(function(revision) {
				if (!revision || revision === state.revision) return;
				state.revision = revision;
				// Something the note borrows from has changed: ask for all of
				// it again, and swap in whatever came back.
				list.forEach(function(element) { load(element, true); });
			}).catch(function() {
				// The plugin is gone (Joplin closing): stop asking.
				clearInterval(state.timer);
				state.timer = null;
			});
		}, POLL_INTERVAL);
	}

	function scan() {
		state.pending = false;
		var list = embeds();
		list.forEach(function(element) { load(element, false); });
		poll();
	}

	function schedule() {
		if (state.pending) return;
		state.pending = true;
		setTimeout(scan, 20);
	}

	function bind() {
		if (state.bound) return;
		state.bound = true;

		// A link to another note, either the embed's own source line or a note
		// link inside the content that was borrowed.
		document.addEventListener('click', function(event) {
			var node = event.target;
			while (node && node !== document) {
				if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-rsx-note')) {
					event.preventDefault();
					post({ type: 'openNote', id: node.getAttribute('data-rsx-note') });
					return;
				}
				node = node.parentNode;
			}
		});

		if (typeof MutationObserver !== 'undefined' && document.body) {
			new MutationObserver(function(records) {
				for (var i = 0; i < records.length; i++) {
					if (records[i].addedNodes && records[i].addedNodes.length) {
						schedule();
						return;
					}
				}
			}).observe(document.body, { childList: true, subtree: true });
		}
	}

	function start() {
		bind();
		post({ type: 'settings' }).then(function(settings) {
			applySettings(settings);
			scan();
		}).catch(function() {
			applySettings({});
			scan();
		});
	}

	if (document.body) start();
	else document.addEventListener('DOMContentLoaded', start);
})();
