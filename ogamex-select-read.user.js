// ==UserScript==
// @name         OGameX Message Tools
// @namespace    https://github.com/ssps6210/ogamex-select-read
// @version      1.3.1
// @description  Mark All Read + Delete Read across all tabs and pages
// @author       ssps6210
// @match        https://*.ogamex.dev/*
// @match        http://localhost/*
// @updateURL    https://raw.githubusercontent.com/ssps6210/ogamex-select-read/main/ogamex-select-read.user.js
// @downloadURL  https://raw.githubusercontent.com/ssps6210/ogamex-select-read/main/ogamex-select-read.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BATCH   = 5;    // parallel mark-read requests
    const PAGE_MS = 100;  // delay between page fetches
    const MSG_MS  = 60;   // delay between individual mark-read calls in a batch

    // ============================================================
    // CSRF
    // ============================================================
    function getCSRF() {
        return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? null;
    }
    function saveCSRF(token) {
        if (!token) return;
        document.querySelector('meta[name="csrf-token"]')?.setAttribute('content', token);
    }

    // ============================================================
    // Collect all tab URLs to scan.
    //
    // Bug fixed: the old logic returned ONLY subtab URLs when any
    // subtab was found in the DOM, silently skipping Economy,
    // Universe, System, and Favorites (which have no subtabs and
    // must be addressed via their main tab URL). It also missed
    // Communication subtabs when that tab hadn't been opened yet.
    //
    // New logic:
    //   1. Collect all /ajax/messages links currently in the DOM.
    //   2. For each main tab whose subtabs ARE already in the DOM,
    //      use those subtab URLs (skip the parent tab URL).
    //   3. For each main tab whose subtabs are NOT in the DOM yet,
    //      fetch that tab URL once to discover subtabs dynamically.
    //      If the response contains subtab links → use those.
    //      If not (Economy / Universe / System / Favorites) → use
    //      the main tab URL directly (it returns messages directly).
    // ============================================================
    async function getTabUrls() {
        const seen = new Set();
        const domUrls = [];
        for (const a of document.querySelectorAll('a[href*="/ajax/messages"]')) {
            const href = a.getAttribute('href');
            if (!href) continue;
            if (/\/ajax\/messages\/\d+/.test(href)) continue;
            const abs = new URL(href, window.location.origin).href;
            if (!seen.has(abs)) { seen.add(abs); domUrls.push(abs); }
        }
        if (!domUrls.length) return [];

        // Subtab URLs already present in the DOM (from whatever tab is active)
        const domSubtabs = domUrls.filter(u => u.includes('subtab='));
        const tabsWithSubtabsInDom = new Set(
            domSubtabs.map(u => new URL(u).searchParams.get('tab'))
        );

        const result = [...domSubtabs];
        domSubtabs.forEach(u => seen.add(u));

        // For each main tab link, decide whether to use the tab URL or fetch subtabs
        const mainTabUrls = domUrls.filter(u => u.includes('tab=') && !u.includes('subtab='));
        for (const tabUrl of mainTabUrls) {
            const tabKey = new URL(tabUrl).searchParams.get('tab');
            if (tabsWithSubtabsInDom.has(tabKey)) continue; // subtabs already covered

            // Fetch the tab to discover its structure
            const res  = await fetch(tabUrl, { credentials: 'same-origin' });
            const html = await res.text();
            const doc  = new DOMParser().parseFromString(html, 'text/html');

            const subLinks = [...doc.querySelectorAll('a[href*="subtab="]')]
                .map(a => new URL(a.getAttribute('href'), window.location.origin).href)
                .filter(u => !seen.has(u));

            if (subLinks.length > 0) {
                // Tab has subtabs (e.g. Communication) — use those
                subLinks.forEach(u => { seen.add(u); result.push(u); });
            } else {
                // No subtabs (Economy / Universe / System / Favorites) —
                // the tab URL itself returns messages directly
                if (!seen.has(tabUrl)) { seen.add(tabUrl); result.push(tabUrl); }
            }
        }

        return result;
    }

    // ============================================================
    // Parse total pages from fetched HTML.
    //
    // Bug fixed: the old regex matched the first "N/M" pattern in
    // the entire HTML, which could be a false match from message
    // body content appearing before the pagination element.
    //
    // New logic: prefer the DOM's <li class="curPage"> element
    // (OGameX renders "currentPage/totalPages" there), fall back
    // to the raw regex only if the element isn't found.
    // ============================================================
    function parseTotalPages(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const curPage = doc.querySelector('li.curPage');
        if (curPage) {
            const m = curPage.textContent.match(/\d+\s*\/\s*(\d+)/);
            if (m) return parseInt(m[1]);
        }
        // Fallback for any template variant that renders it differently
        const m = html.match(/\d+\s*\/\s*(\d+)/);
        return m ? parseInt(m[1]) : 1;
    }

    // ============================================================
    // Fetch one tab page and return { unreadIds, readIds, totalPages }
    // ============================================================
    async function fetchTabPage(tabUrl, page) {
        const sep = tabUrl.includes('?') ? '&' : '?';
        const url = `${tabUrl}${sep}pagination=${page}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        const html = await res.text();

        const doc      = new DOMParser().parseFromString(html, 'text/html');
        const allMsgs   = [...doc.querySelectorAll('li.msg[data-msg-id]')];
        const unreadIds = allMsgs.filter(el => el.classList.contains('msg_new')).map(el => el.dataset.msgId);
        const readIds   = allMsgs.filter(el => !el.classList.contains('msg_new')).map(el => el.dataset.msgId);
        const allIds    = allMsgs.map(el => el.dataset.msgId);
        const totalPages = parseTotalPages(html);
        return { unreadIds, readIds, allIds, totalPages };
    }

    // ============================================================
    // Collect all unread (or read) IDs across all tabs and pages
    // ============================================================
    async function collectIds(type = 'unread') {
        const tabUrls = await getTabUrls();   // now async
        if (!tabUrls.length) {
            setLog('⚠ No tabs found in DOM');
            return [];
        }

        const allIds = [];
        for (const tabUrl of tabUrls) {
            const first = await fetchTabPage(tabUrl, 1);

            if (type === 'unread') {
                // OGameX always adds msg_new for unread messages across all
                // message types (espionage, combat, expeditions, etc.).
                // If a tab page has no msg_new, it has no unread → skip it.
                if (first.unreadIds.length > 0) {
                    allIds.push(...first.unreadIds);
                    for (let p = 2; p <= first.totalPages; p++) {
                        await delay(PAGE_MS);
                        const page = await fetchTabPage(tabUrl, p);
                        allIds.push(...page.unreadIds);
                        if (page.unreadIds.length === 0) break;
                    }
                }
            } else {
                allIds.push(...first.readIds);
                for (let p = 2; p <= first.totalPages; p++) {
                    await delay(PAGE_MS);
                    const page = await fetchTabPage(tabUrl, p);
                    allIds.push(...page.readIds);
                    if (page.readIds.length === 0) break;
                }
            }
        }
        // deduplicate
        return [...new Set(allIds)];
    }

    // ============================================================
    // Mark one message as read by fetching it
    // ============================================================
    async function markRead(id) {
        await fetch(`/ajax/messages/${id}`, { credentials: 'same-origin' });
        document.querySelector(`li.msg.msg_new[data-msg-id="${id}"]`)?.classList.remove('msg_new');
    }

    // ============================================================
    // Delete one message via action 103
    // ============================================================
    async function deleteMsg(id) {
        const body = new FormData();
        body.append('_token',    getCSRF());
        body.append('messageId', id);
        body.append('action',    103);
        body.append('ajax',      1);
        const res  = await fetch('/messages', {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'same-origin',
            body,
        });
        const data = await res.json().catch(() => ({}));
        if (data.newAjaxToken) saveCSRF(data.newAjaxToken);
        document.querySelector(`li.msg[data-msg-id="${id}"]`)?.remove();
    }

    // ============================================================
    // Run fn on ids in parallel batches
    // ============================================================
    async function runBatched(ids, fn, labelPrefix) {
        let done = 0;
        for (let i = 0; i < ids.length; i += BATCH) {
            const batch = ids.slice(i, i + BATCH);
            await Promise.all(batch.map(id => fn(id)));
            done += batch.length;
            setLog(`${labelPrefix} ${done}/${ids.length}…`);
            if (i + BATCH < ids.length) await delay(MSG_MS);
        }
    }

    // ============================================================
    // Button handlers
    // ============================================================
    async function markAllRead() {
        setBusy(true);
        setLog('Scanning tabs…');
        const ids = await collectIds('unread');
        if (!ids.length) { setLog('Nothing unread'); setBusy(false); return; }
        setLog(`Found ${ids.length} unread`);
        await runBatched(ids, markRead, 'Marking');
        setLog(`✅ ${ids.length} marked read`);
        setBusy(false);
    }

    async function deleteRead() {
        setBusy(true);
        setLog('Scanning tabs…');
        const ids = await collectIds('read');
        if (!ids.length) { setLog('No read messages'); setBusy(false); return; }

        const ok = confirm(`Delete ${ids.length} read messages across all tabs?`);
        if (!ok) { setLog('Cancelled'); setBusy(false); return; }

        await runBatched(ids, deleteMsg, 'Deleting');
        setLog(`✅ Deleted ${ids.length}`);
        setBusy(false);
    }

    // ============================================================
    // Floating widget
    // ============================================================
    let _widget = null;

    function buildWidget() {
        if (_widget) return;

        const div = document.createElement('div');
        div.id = 'msg-tools-widget';
        div.innerHTML = `
            <div style="font:11px monospace;color:#88aaff;margin-bottom:6px;letter-spacing:1px;">✉ MSG TOOLS</div>
            <div style="display:flex;flex-direction:column;gap:5px;">
                <button id="mt-mark-read"
                    style="background:#2a1a3a;color:#c8a0ff;border:1px solid #7040a0;
                    padding:3px 10px;border-radius:3px;cursor:pointer;font:11px monospace;">
                    Mark All Read
                </button>
                <button id="mt-delete-read"
                    style="background:#2a1a1a;color:#ff8080;border:1px solid #a04040;
                    padding:3px 10px;border-radius:3px;cursor:pointer;font:11px monospace;">
                    Delete Read
                </button>
            </div>
            <div id="mt-log" style="font:10px monospace;color:#888;margin-top:5px;min-height:14px;max-width:160px;word-break:break-word;"></div>
        `;
        div.style.cssText = `
            position:fixed; bottom:60px; right:12px; z-index:99999;
            background:rgba(0,0,0,0.88); border:1px solid #446;
            border-radius:5px; padding:10px 14px; min-width:160px;
            box-shadow:0 0 12px rgba(0,0,0,0.6);
        `;

        div.querySelector('#mt-mark-read').addEventListener('click', markAllRead);
        div.querySelector('#mt-delete-read').addEventListener('click', deleteRead);

        document.body.appendChild(div);
        _widget = div;
    }

    function removeWidget() { _widget?.remove(); _widget = null; }

    function setLog(msg) {
        if (_widget) _widget.querySelector('#mt-log').textContent = msg;
        console.log('[MsgTools]', msg);
    }

    function setBusy(busy) {
        if (!_widget) return;
        _widget.querySelector('#mt-mark-read').disabled   = busy;
        _widget.querySelector('#mt-delete-read').disabled = busy;
    }

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ============================================================
    // Show/hide on navigation
    // ============================================================
    function update() {
        if (window.location.pathname.startsWith('/messages')) buildWidget();
        else removeWidget();
    }

    new MutationObserver(update).observe(document.body, { childList: true, subtree: false });
    window.addEventListener('popstate', update);
    update();
})();
