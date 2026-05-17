// ==UserScript==
// @name         OGameX Message Tools
// @namespace    https://github.com/ssps6210/ogamex-select-read
// @version      1.2.3
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
    // Collect all tab URLs from the DOM (subtabs take priority)
    // ============================================================
    function getTabUrls() {
        const seen = new Set();
        const urls = [];
        for (const a of document.querySelectorAll('a[href*="/ajax/messages"]')) {
            const href = a.getAttribute('href');
            if (!href) continue;
            // Skip individual message links (/ajax/messages/12345)
            if (/\/ajax\/messages\/\d+/.test(href)) continue;
            // Prefer subtab URLs; skip parent tab URLs if subtabs exist
            const abs = new URL(href, window.location.origin).href;
            if (!seen.has(abs)) { seen.add(abs); urls.push(abs); }
        }
        // Keep only subtab URLs if any exist, else fall back to tab URLs
        const subtabs = urls.filter(u => u.includes('subtab='));
        return subtabs.length ? subtabs : urls.filter(u => u.includes('tab='));
    }

    // ============================================================
    // Parse total pages from fetched HTML
    // Handles: "1 / 72", "1/72", etc.
    // ============================================================
    function parseTotalPages(html) {
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

        const parser   = new DOMParser();
        const doc      = parser.parseFromString(html, 'text/html');
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
        const tabUrls = getTabUrls();
        if (!tabUrls.length) {
            setLog('⚠ No tabs found in DOM');
            return [];
        }

        const allIds = [];
        for (const tabUrl of tabUrls) {
            const first = await fetchTabPage(tabUrl, 1);

            if (type === 'unread') {
                if (first.unreadIds.length > 0) {
                    // Tab uses msg_new — scan pages with early exit
                    allIds.push(...first.unreadIds);
                    for (let p = 2; p <= first.totalPages; p++) {
                        await delay(PAGE_MS);
                        const page = await fetchTabPage(tabUrl, p);
                        allIds.push(...page.unreadIds);
                        if (page.unreadIds.length === 0) break;
                    }
                } else if (first.allIds.length > 0) {
                    // Tab has no msg_new (e.g. combat reports) —
                    // mark all on page 1 as read and stop
                    allIds.push(...first.allIds);
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
