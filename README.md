# OGameX Message Tools

A Tampermonkey userscript that adds a floating widget to the OGameX messages page for bulk marking messages as read and deleting read messages across all tabs.

## Features

- **Mark All Read** — scans every tab and subtab, marks all unread messages as read in one click
- **Delete Read** — collects all read messages across all tabs and deletes them after confirmation
- Processes pages in parallel batches for speed
- Status log shows live progress

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click **[Install Script](https://raw.githubusercontent.com/ssps6210/ogamex-select-read/main/ogamex-select-read.user.js)**
3. Tampermonkey will prompt for confirmation — click Install

The widget (✉ MSG TOOLS) appears in the bottom-right corner whenever you visit the `/messages` page.

## How It Works

### Tab Discovery (auto-fetch)

When you click a button, the script automatically discovers all tabs to scan:

1. Reads tab and subtab links already loaded in the DOM
2. For any tab whose subtabs are **not yet loaded** (e.g. you haven't clicked Communication yet), it silently fetches that tab in the background to discover its subtabs
3. Tabs with no subtabs (Economy, Universe, System, Favorites) are scanned directly via their main tab URL

This means you do **not** need to manually open each tab before clicking — the script handles it automatically.

### Mark All Read

- Tabs that use the `msg_new` CSS class: scans page by page with early exit once no more unread messages are found
- Tabs without `msg_new` indicators (e.g. combat reports): marks all messages on the first 3 pages as read

### Delete Read

- Collects all read message IDs across every tab and page
- Shows a confirmation dialog with the total count before deleting

## Compatibility

- OGameX servers on `*.ogamex.dev`
- `localhost` (for self-hosted OGameX instances)

## Changelog

### 1.3.0
- Fixed: Economy, Universe, System, Favorites, and Communication tabs were silently skipped when Fleet subtabs were already loaded in the DOM
- Fixed: page count detection now uses the `li.curPage` DOM element instead of a raw regex, preventing false matches from message body content

### 1.2.4
- Initial public release
