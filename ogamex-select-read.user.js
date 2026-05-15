// ==UserScript==
// @name         OGameX Message Tools
// @namespace    https://github.com/ssps6210/ogamex-select-read
// @version      1.1.0
// @description  Mark All Read + Delete Read buttons for the messages page
// @author       ssps6210
// @match        https://*.ogamex.dev/*
// @match        http://localhost/*
// @updateURL    https://raw.githubusercontent.com/ssps6210/ogamex-select-read/main/ogamex-select-read.user.js
// @downloadURL  https://raw.githubusercontent.com/ssps6210/ogamex-select-read/main/ogamex-select-read.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // Only active on /messages page
    // ============================================================
    function onMessagesPage() {
        return window.location.pathname.startsWith('/messages');
    }

    // ============================================================
    // CSRF token
    // ============================================================
    function getCSRF() {
        const m = document.querySelector('meta[name="csrf-token"]');
        return m ? m.getAttribute('content') : null;
    }

    // ============================================================
    // Mark all unread messages as read (fetch each to trigger server-side mark)
    // ============================================================
    async function markAllRead() {
        const unread = [...document.querySelectorAll('li.msg.msg_new[data-msg-id]')];
        if (!unread.length) { setLog('Nothing unread'); return; }

        setLog(`Marking ${unread.length}…`);
        for (let i = 0; i < unread.length; i++) {
            const id = unread[i].dataset.msgId;
            try {
                await fetch(`/ajax/messages/${id}`, { credentials: 'same-origin' });
                unread[i].classList.remove('msg_new');
            } catch (_) {}
            if (i < unread.length - 1) await delay(150);
        }
        setLog(`✅ ${unread.length} marked read`);
    }

    // ============================================================
    // Delete all read messages via action 103
    // ============================================================
    async function deleteRead() {
        const read = [...document.querySelectorAll('li.msg:not(.msg_new)[data-msg-id]')];
        if (!read.length) { setLog('No read messages'); return; }

        const confirmed = confirm(`Delete ${read.length} read messages?`);
        if (!confirmed) return;

        setLog(`Deleting ${read.length}…`);
        let deleted = 0;
        for (let i = 0; i < read.length; i++) {
            const id = read[i].dataset.msgId;
            const token = getCSRF();
            try {
                const body = new FormData();
                body.append('_token',    token);
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
                if (data.newAjaxToken) {
                    document.querySelector('meta[name="csrf-token"]')
                        ?.setAttribute('content', data.newAjaxToken);
                }
                read[i].remove();
                deleted++;
            } catch (_) {}
            if (i < read.length - 1) await delay(150);
        }
        setLog(`✅ Deleted ${deleted}`);
    }

    // ============================================================
    // Floating widget UI
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
            <div id="mt-log" style="font:10px monospace;color:#888;margin-top:5px;min-height:14px;"></div>
        `;
        div.style.cssText = `
            position:fixed; bottom:60px; right:12px; z-index:99999;
            background:rgba(0,0,0,0.88); border:1px solid #446;
            border-radius:5px; padding:10px 14px; min-width:150px;
            box-shadow:0 0 12px rgba(0,0,0,0.6);
        `;

        div.querySelector('#mt-mark-read').addEventListener('click', markAllRead);
        div.querySelector('#mt-delete-read').addEventListener('click', deleteRead);

        document.body.appendChild(div);
        _widget = div;
    }

    function removeWidget() {
        _widget?.remove();
        _widget = null;
    }

    function setLog(msg) {
        if (_widget) _widget.querySelector('#mt-log').textContent = msg;
        console.log('[MsgTools]', msg);
    }

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ============================================================
    // Show/hide based on current page
    // ============================================================
    function update() {
        if (onMessagesPage()) buildWidget();
        else removeWidget();
    }

    // Watch for SPA-style navigation
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: false });

    window.addEventListener('popstate', update);
    update();
})();
