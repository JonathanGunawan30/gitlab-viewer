import fs from 'node:fs';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import * as Diff2Html from 'diff2html';

const require = createRequire(import.meta.url);

// Cache embedded static libraries for high performance and offline capability
const DIFF2HTML_CSS = fs.readFileSync(require.resolve('diff2html/bundles/css/diff2html.min.css'), 'utf8');
const DIFF2HTML_JS = fs.readFileSync(require.resolve('diff2html/bundles/js/diff2html-ui.min.js'), 'utf8');
const HLJS_DARK_CSS = fs.readFileSync(require.resolve('highlight.js/styles/github-dark.min.css'), 'utf8');

// Configure marked
marked.setOptions({
  gfm: true,
  breaks: true
});

function createSanitizeOptions(baseUrl = '') {
  let projectBase = '';
  let origin = '';
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      origin = u.origin;
      const mrIndex = u.pathname.indexOf('/-/merge_requests/');
      if (mrIndex !== -1) {
        projectBase = u.origin + u.pathname.slice(0, mrIndex) + '/';
      } else {
        const altIndex = u.pathname.indexOf('/merge_requests/');
        if (altIndex !== -1) {
          projectBase = u.origin + u.pathname.slice(0, altIndex) + '/';
        } else {
          projectBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
        }
      }
    } catch {}
  }

  return {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
      'nl', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
      'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'span',
      'img', 'del', 'sup', 'sub', 'details', 'summary', 'input'
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      input: ['type', 'checked', 'disabled'],
      span: ['class', 'style'],
      div: ['class'],
      code: ['class'],
      pre: ['class'],
      th: ['align', 'colspan', 'rowspan'],
      td: ['align', 'colspan', 'rowspan']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data']
    },
    transformTags: {
      'a': (tagName, attribs) => {
        const cleanHref = (attribs.href || '').trim();
        if (/^(javascript|vbscript|data):/i.test(cleanHref)) {
          delete attribs.href;
        }
        return {
          tagName: 'a',
          attribs: {
            ...attribs,
            target: '_blank',
            rel: 'noopener noreferrer'
          }
        };
      },
      'img': (tagName, attribs) => {
        let src = (attribs.src || '').trim();
        if (src.startsWith('data:')) {
          return {
            tagName: 'img',
            attribs: {
              ...attribs,
              src
            }
          };
        }
        if ((src.startsWith('/uploads/') || src.startsWith('uploads/')) && projectBase) {
          try {
            const cleanSub = src.replace(/^\/?uploads\//, 'uploads/');
            src = new URL(cleanSub, projectBase).href;
          } catch {}
        } else if (src.startsWith('/') && origin) {
          try {
            src = new URL(src, origin).href;
          } catch {}
        }
        return {
          tagName: 'img',
          attribs: {
            ...attribs,
            src
          }
        };
      },
      'input': (tagName, attribs) => {
        if (attribs.type === 'checkbox') {
          return {
            tagName: 'input',
            attribs: {
              type: 'checkbox',
              disabled: 'disabled',
              ...(attribs.checked !== undefined ? { checked: attribs.checked } : {})
            }
          };
        }
        return { tagName: 'span', attribs: {} };
      }
    }
  };
}

/**
 * Parses and sanitizes Markdown to prevent XSS attacks.
 * @param {string} markdownText
 * @param {string} [baseUrl] - Base URL (e.g. MR web_url) to resolve relative GitLab assets
 * @returns {string}
 */
export function renderMarkdown(markdownText, baseUrl = '') {
  if (!markdownText || typeof markdownText !== 'string') return '';
  const rawHtml = marked.parse(markdownText);
  return sanitizeHtml(rawHtml, createSanitizeOptions(baseUrl));
}

/**
 * Escapes string for safe JSON embedding in HTML script tag
 * @param {any} obj
 * @returns {string}
 */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\u002f');
}

/**
 * Calculates diff statistics from unified diff or changes array.
 * @param {string} rawDiff
 * @param {Array<any>} changes
 */
export function calculateStats(rawDiff, changes = []) {
  let totalAdditions = 0;
  let totalDeletions = 0;
  let files = [];

  try {
    const parsed = Diff2Html.parse(rawDiff);
    files = parsed.map(f => {
      const added = f.addedLines || 0;
      const deleted = f.deletedLines || 0;
      totalAdditions += added;
      totalDeletions += deleted;

      let status = 'M';
      if (f.isNew) status = 'A';
      else if (f.isDeleted) status = 'D';
      else if (f.isRename) status = 'R';

      return {
        name: f.newName || f.oldName,
        oldName: f.oldName,
        newName: f.newName,
        status,
        added,
        deleted
      };
    });
  } catch {
    files = changes.map(c => {
      let status = 'M';
      if (c.new_file) status = 'A';
      else if (c.deleted_file) status = 'D';
      else if (c.renamed_file) status = 'R';
      return {
        name: c.new_path || c.old_path,
        oldName: c.old_path,
        newName: c.new_path,
        status,
        added: 0,
        deleted: 0
      };
    });
  }

  return {
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    files
  };
}

/**
 * Generates the complete, self-contained standalone HTML viewer.
 * 
 * @param {object} options
 * @param {any} options.mr
 * @param {string} options.rawDiff
 * @param {Array<any>} options.changes
 * @param {Array<any>} options.discussions
 * @param {Record<string, any>} [options.imageDiffs]
 * @returns {string} Standalone HTML content
 */
export function generateViewerHtml({ mr, rawDiff, changes = [], discussions = [], imageDiffs = {} }) {
  const stats = calculateStats(rawDiff, changes);
  const baseUrl = mr.web_url || '';
  const descriptionHtml = mr.description 
    ? renderMarkdown(mr.description, baseUrl) 
    : '<p class="text-muted"><em>No description provided for this Merge Request.</em></p>';

  const formattedDiscussions = discussions
    .filter(d => Array.isArray(d.notes) && d.notes.length > 0)
    .map(d => ({
      id: d.id,
      notes: d.notes.map(n => ({
        id: n.id,
        author: n.author ? {
          name: n.author.name,
          username: n.author.username,
          avatarUrl: n.author.avatar_url
        } : null,
        bodyHtml: renderMarkdown(n.body || '', baseUrl),
        createdAt: n.created_at,
        resolvable: n.resolvable,
        resolved: n.resolved
      }))
    }));

  const isDraft = Boolean(mr.draft || mr.work_in_progress);
  const badgeClass = isDraft ? 'draft' : (mr.state || 'opened');
  const badgeLabels = {
    draft: 'DRAFT',
    opened: 'OPEN',
    merged: 'MERGED',
    closed: 'CLOSED',
    locked: 'LOCKED'
  };
  const badgeLabel = isDraft ? 'DRAFT' : (badgeLabels[mr.state] || (mr.state || 'OPEN').toUpperCase());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: http: data:;">
  <title>MR !${mr.iid}: ${escapeHtml(mr.title)} | GitLab Viewer</title>
  <style>
    /* Base Diff2Html Styles */
    ${DIFF2HTML_CSS}

    /* Highlight.js GitHub Dark Theme */
    ${HLJS_DARK_CSS}
  </style>
  <style>
    /* ========================================================= */
    /* PURE DARK THEME DESIGN SYSTEM & CSS VARIABLES            */
    /* ========================================================= */
    :root {
      --d2h-bg-color: #0d1117;
      --d2h-border-color: #30363d;
      --d2h-dim-color: #6e7681;
      --d2h-line-border-color: #21262d;
      --d2h-file-header-bg-color: #161b22;
      --d2h-file-header-border-color: #30363d;
      --d2h-empty-placeholder-bg-color: #090d13;
      --d2h-empty-placeholder-border-color: #21262d;
      --d2h-selected-color: rgba(56, 139, 253, 0.15);

      --d2h-ins-bg-color: rgba(46, 160, 67, 0.16);
      --d2h-ins-border-color: rgba(46, 160, 67, 0.4);
      --d2h-ins-highlight-bg-color: rgba(46, 160, 67, 0.45);
      --d2h-ins-label-color: #3fb950;

      --d2h-del-bg-color: rgba(248, 81, 73, 0.16);
      --d2h-del-border-color: rgba(248, 81, 73, 0.4);
      --d2h-del-highlight-bg-color: rgba(248, 81, 73, 0.45);
      --d2h-del-label-color: #f85149;

      --d2h-info-bg-color: rgba(56, 139, 253, 0.1);
      --d2h-info-border-color: rgba(56, 139, 253, 0.3);

      --bg-canvas: #090d13;
      --bg-panel: #0d1117;
      --bg-card: #161b22;
      --bg-hover: #21262d;
      --border-default: #30363d;
      --border-subtle: #21262d;

      --text-main: #f0f6fc;
      --text-muted: #8b949e;
      --text-dim: #6e7681;

      --accent-blue: #58a6ff;
      --accent-blue-hover: #1f6feb;

      --sidebar-width: 320px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      background-color: var(--bg-canvas);
      color: var(--text-main);
      line-height: 1.5;
      overflow-x: hidden;
    }

    /* Custom Modern Dark Scrollbars */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: var(--bg-panel);
    }
    ::-webkit-scrollbar-thumb {
      background: var(--border-default);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--text-dim);
    }

    /* Sticky Top Header */
    header.top-bar {
      position: sticky;
      top: 0;
      z-index: 100;
      background-color: var(--bg-panel);
      border-bottom: 1px solid var(--border-default);
      padding: 10px 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }

    .top-bar-row1 {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }

    .mr-title-area {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .badge-status {
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .badge-opened { background-color: #238636; color: #fff; }
    .badge-merged { background-color: #8957e5; color: #fff; }
    .badge-closed { background-color: #da3633; color: #fff; }
    .badge-locked { background-color: #d29922; color: #fff; }
    .badge-draft { background-color: #484f58; color: #8b949e; }

    .mr-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mr-iid {
      color: var(--text-dim);
      font-weight: 500;
      margin-right: 4px;
    }

    .actions-area {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .btn-group {
      display: inline-flex;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      overflow: hidden;
    }

    .btn {
      background-color: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border-default);
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .btn:hover {
      background-color: var(--bg-hover);
      border-color: var(--accent-blue);
    }
    .btn.active {
      background-color: #1f6feb;
      color: #fff;
      border-color: #388bfd;
      font-weight: 600;
    }
    .btn-group .btn {
      border: none;
      border-radius: 0;
      border-right: 1px solid var(--border-default);
    }
    .btn-group .btn:last-child {
      border-right: none;
    }

    .top-bar-row2 {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12.5px;
      color: var(--text-muted);
      flex-wrap: wrap;
      gap: 12px;
    }

    .branch-flow {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .branch-pill {
      background-color: var(--bg-card);
      border: 1px solid var(--border-default);
      padding: 2px 8px;
      border-radius: 4px;
      color: var(--text-main);
    }

    .stats-summary {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 12px;
    }
    .stat-add { color: #3fb950; font-weight: 600; }
    .stat-del { color: #f85149; font-weight: 600; }
    .stat-files { font-weight: 500; color: var(--text-main); }

    /* Nav Tabs */
    .tabs-bar {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border-default);
      background-color: var(--bg-panel);
      padding: 0 20px;
    }
    .tab-item {
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .tab-item:hover {
      color: var(--text-main);
    }
    .tab-item.active {
      color: var(--accent-blue);
      border-bottom-color: var(--accent-blue);
    }
    .tab-counter {
      background-color: var(--bg-card);
      color: var(--text-muted);
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      border: 1px solid var(--border-default);
    }

    /* Main Container Layout */
    .main-layout {
      display: flex;
      min-height: calc(100vh - 96px);
    }

    /* Sidebar */
    aside.file-sidebar {
      width: var(--sidebar-width, 320px);
      min-width: 200px;
      max-width: 75vw;
      background-color: var(--bg-panel);
      border-right: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      height: calc(100vh - 96px);
      position: sticky;
      top: 96px;
      overflow: hidden;
      flex-shrink: 0;
    }
    aside.file-sidebar.collapsed {
      display: none;
    }
    aside.file-sidebar.collapsed + .sidebar-resizer {
      display: none;
    }

    /* Resizer Divider Bar */
    .sidebar-resizer {
      width: 6px;
      margin-left: -3px;
      margin-right: -3px;
      cursor: col-resize;
      background-color: transparent;
      position: relative;
      z-index: 50;
      flex-shrink: 0;
      transition: background-color 0.15s ease;
      user-select: none;
    }
    .sidebar-resizer:hover,
    .sidebar-resizer.is-resizing {
      background-color: var(--accent-blue);
    }
    body.is-resizing {
      cursor: col-resize !important;
      user-select: none !important;
    }
    body.is-resizing * {
      user-select: none !important;
      pointer-events: none !important;
    }
    body.is-resizing .sidebar-resizer {
      pointer-events: auto !important;
    }

    .sidebar-header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .sidebar-search-box {
      width: 100%;
      background-color: var(--bg-canvas);
      border: 1px solid var(--border-default);
      color: var(--text-main);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      outline: none;
    }
    .sidebar-search-box:focus {
      border-color: var(--accent-blue);
    }

    .review-progress {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
    }
    .progress-bar-track {
      width: 100%;
      height: 4px;
      background-color: var(--bg-hover);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 4px;
    }
    .progress-bar-fill {
      height: 100%;
      background-color: #238636;
      width: 0%;
      transition: width 0.3s ease;
    }

    .file-tree-list {
      list-style: none;
      overflow-y: auto;
      flex: 1;
      padding: 6px 0;
    }
    .file-tree-item {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      font-size: 12px;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      transition: background 0.1s ease;
      border-left: 3px solid transparent;
    }
    .file-tree-item:hover {
      background-color: var(--bg-hover);
    }
    .file-tree-item.active {
      background-color: var(--bg-hover);
      border-left-color: var(--accent-blue);
    }
    .file-tree-item.reviewed {
      opacity: 0.5;
    }

    .file-status-badge {
      font-weight: 700;
      font-size: 10px;
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }
    .status-A { color: #3fb950; }
    .status-D { color: #f85149; }
    .status-M { color: #d29922; }
    .status-R { color: var(--accent-blue); }

    .file-tree-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--text-main);
    }
    .file-tree-diff-stats {
      font-size: 11px;
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }

    /* Content Canvas */
    .content-canvas {
      flex: 1;
      padding: 20px 28px;
      overflow-y: auto;
      min-width: 0;
      background-color: var(--bg-canvas);
    }

    /* Markdown Overview */
    .overview-container {
      background-color: var(--bg-panel);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 24px 30px;
      max-width: 900px;
      margin: 0 auto;
      line-height: 1.7;
    }
    .overview-container h1, .overview-container h2, .overview-container h3 {
      margin-top: 18px;
      margin-bottom: 8px;
      color: var(--text-main);
    }
    .overview-container p, .overview-container ul, .overview-container ol {
      margin-bottom: 12px;
      color: var(--text-main);
    }
    .overview-container pre {
      background-color: var(--bg-card);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      margin-bottom: 14px;
    }
    .overview-container code {
      background-color: var(--bg-card);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }

    /* Discussions */
    .discussions-container {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .discussion-card {
      background-color: var(--bg-panel);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      overflow: hidden;
    }
    .discussion-header {
      background-color: var(--bg-card);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      border-bottom: 1px solid var(--border-default);
    }
    .discussion-body {
      padding: 16px;
      font-size: 13px;
      line-height: 1.6;
    }

    /* ========================================================= */
    /* DIFF2HTML COHESIVE DARK THEME OVERRIDES                  */
    /* ========================================================= */
    .d2h-wrapper {
      text-align: left;
      background-color: transparent !important;
    }

    .d2h-file-wrapper {
      border: 1px solid var(--border-default) !important;
      border-radius: 8px !important;
      margin-bottom: 24px !important;
      background-color: var(--bg-panel) !important;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    /* File Header */
    .d2h-file-header {
      background-color: var(--bg-card) !important;
      border-bottom: 1px solid var(--border-default) !important;
      padding: 8px 16px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      height: 42px !important;
    }

    .d2h-file-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      color: var(--text-main) !important;
    }

    /* Hunk / Chunk Info Header with Interactive Expansion */
    .d2h-info {
      background-color: #121926 !important;
      color: #79c0ff !important;
      border-color: #1e283d !important;
      font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace !important;
      font-size: 11.5px !important;
      padding: 4px 10px !important;
      position: relative;
    }
    .d2h-info .d2h-code-line-prefix {
      color: #79c0ff !important;
    }

    /* Line Numbers Gutter: Soft Muted Gray, NEVER White! */
    .d2h-code-linenumber,
    .d2h-code-side-linenumber {
      background-color: #0d1117 !important;
      color: #6e7681 !important;
      border-color: #21262d !important;
      font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace !important;
      font-size: 11.5px !important;
      user-select: none;
    }

    /* Line numbers on added lines */
    .d2h-ins .d2h-code-linenumber,
    .d2h-ins.d2h-code-side-linenumber,
    tr.d2h-ins .d2h-code-side-linenumber {
      background-color: rgba(46, 160, 67, 0.15) !important;
      color: #3fb950 !important;
      border-color: rgba(46, 160, 67, 0.3) !important;
    }

    /* Line numbers on deleted lines */
    .d2h-del .d2h-code-linenumber,
    .d2h-del.d2h-code-side-linenumber,
    tr.d2h-del .d2h-code-side-linenumber {
      background-color: rgba(248, 81, 73, 0.15) !important;
      color: #f85149 !important;
      border-color: rgba(248, 81, 73, 0.3) !important;
    }

    /* Code Font & Formatting */
    .d2h-code-line, 
    .d2h-code-side-line {
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
      font-size: 12.5px !important;
      line-height: 20px !important;
      background-color: #0d1117 !important;
      color: #c9d1d9 !important;
    }

    /* High-contrast Additions */
    .d2h-ins {
      background-color: rgba(46, 160, 67, 0.16) !important;
      border-color: rgba(46, 160, 67, 0.4) !important;
    }
    .d2h-ins .d2h-code-line,
    .d2h-ins .d2h-code-side-line {
      background-color: rgba(46, 160, 67, 0.16) !important;
    }
    .d2h-ins .d2h-code-line-prefix {
      color: #3fb950 !important;
      font-weight: 700 !important;
    }
    .d2h-ins ins {
      background-color: rgba(46, 160, 67, 0.45) !important;
      border-radius: 3px !important;
      text-decoration: none !important;
      padding: 1px 3px !important;
      box-shadow: 0 0 0 1px rgba(46, 160, 67, 0.7);
      font-weight: 600 !important;
    }

    /* High-contrast Deletions */
    .d2h-del {
      background-color: rgba(248, 81, 73, 0.16) !important;
      border-color: rgba(248, 81, 73, 0.4) !important;
    }
    .d2h-del .d2h-code-line,
    .d2h-del .d2h-code-side-line {
      background-color: rgba(248, 81, 73, 0.16) !important;
    }
    .d2h-del .d2h-code-line-prefix {
      color: #f85149 !important;
      font-weight: 700 !important;
    }
    .d2h-del del {
      background-color: rgba(248, 81, 73, 0.45) !important;
      border-radius: 3px !important;
      text-decoration: line-through !important;
      padding: 1px 3px !important;
      box-shadow: 0 0 0 1px rgba(248, 81, 73, 0.7);
      font-weight: 600 !important;
    }

    /* Empty Placeholders in Split Mode: Deep Dark Slate, Zero White */
    .d2h-emptyplaceholder,
    .d2h-code-side-emptyplaceholder {
      background-color: #090d13 !important;
      border-color: #1e242c !important;
    }

    .file-actions-btn {
      background: var(--bg-canvas);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      color: var(--text-muted);
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .file-actions-btn:hover {
      background-color: var(--bg-hover);
      color: var(--text-main);
      border-color: var(--accent-blue);
    }

    /* Markdown Images Styling */
    .markdown-body img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      margin: 10px 0;
      display: inline-block;
      vertical-align: middle;
      background-color: var(--bg-panel);
    }

    /* ========================================================= */
    /* IMAGE DIFF VIEWER STYLES                                 */
    /* ========================================================= */
    .image-diff-wrapper {
      padding: 16px 20px;
      background-color: var(--bg-panel);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .image-diff-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .image-diff-badge-status {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .image-diff-badge-status.added {
      background-color: rgba(46, 160, 67, 0.2);
      color: #3fb950;
      border: 1px solid rgba(46, 160, 67, 0.4);
    }
    .image-diff-badge-status.deleted {
      background-color: rgba(248, 81, 73, 0.2);
      color: #f85149;
      border: 1px solid rgba(248, 81, 73, 0.4);
    }
    .image-diff-badge-status.modified {
      background-color: rgba(210, 153, 34, 0.2);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
    }

    .image-diff-view-modes {
      display: inline-flex;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      overflow: hidden;
    }
    .image-diff-view-btn {
      background: var(--bg-card);
      border: none;
      border-right: 1px solid var(--border-default);
      color: var(--text-muted);
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .image-diff-view-btn:last-child {
      border-right: none;
    }
    .image-diff-view-btn:hover {
      background-color: var(--bg-hover);
      color: var(--text-main);
    }
    .image-diff-view-btn.active {
      background-color: var(--accent-blue-hover);
      color: #fff;
      font-weight: 600;
    }

    .image-diff-content {
      width: 100%;
    }

    .image-canvas-checkerboard {
      background-color: #0d1117;
      background-image: 
        linear-gradient(45deg, #161b22 25%, transparent 25%),
        linear-gradient(-45deg, #161b22 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #161b22 75%),
        linear-gradient(-45deg, transparent 75%, #161b22 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: auto;
      max-width: 100%;
      min-height: 120px;
      position: relative;
    }

    .image-diff-preview {
      max-width: 100%;
      max-height: 520px;
      object-fit: contain;
      display: block;
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      cursor: zoom-in;
      transition: transform 0.2s ease;
    }
    .image-diff-preview.zoomed {
      max-height: none;
      max-width: none;
      cursor: zoom-out;
    }
    .image-diff-preview.image-deleted {
      opacity: 0.8;
      filter: grayscale(40%);
    }

    .image-diff-meta {
      font-size: 11px;
      color: var(--text-dim);
      font-family: ui-monospace, monospace;
      margin-top: 6px;
      text-align: center;
    }

    /* 2-Up Side-by-side */
    .image-diff-2up {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      width: 100%;
    }
    @media (max-width: 768px) {
      .image-diff-2up {
        grid-template-columns: 1fr;
      }
    }
    .image-diff-pane {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .image-pane-title {
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Swipe / Slider */
    .image-diff-swipe-wrapper {
      position: relative;
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      border-radius: 4px;
    }
    .image-diff-swipe-before {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      overflow: hidden;
      border-right: 2px solid var(--accent-blue);
      z-index: 2;
    }
    .image-diff-swipe-before img,
    .image-diff-swipe-after img {
      max-height: 520px;
      display: block;
    }
    .image-diff-slider-input {
      width: 100%;
      max-width: 500px;
      margin-top: 12px;
      cursor: ew-resize;
      accent-color: var(--accent-blue);
    }

    /* Onion Skin */
    .image-diff-onion-wrapper {
      position: relative;
      display: inline-block;
    }
    .image-diff-onion-after {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    .image-diff-onion-after img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .image-diff-onion-slider {
      width: 100%;
      max-width: 500px;
      margin-top: 12px;
      accent-color: var(--accent-blue);
    }
  </style>
</head>
<body>
  <!-- Top Bar -->
  <header class="top-bar">
    <div class="top-bar-row1">
      <div class="mr-title-area">
        <span class="badge-status badge-${badgeClass}">${badgeLabel}</span>
        <h1 class="mr-title">
          <span class="mr-iid">!${mr.iid}</span>${escapeHtml(mr.title)}
        </h1>
      </div>

      <div class="actions-area">
        <div class="btn-group">
          <button id="btn-side-by-side" class="btn active" title="Side-by-Side (Split) View">Split</button>
          <button id="btn-line-by-line" class="btn" title="Unified (Inline) View">Unified</button>
        </div>

        <button id="btn-toggle-sidebar" class="btn" title="Toggle File Sidebar">
          📁 Files
        </button>

        <a href="${mr.web_url || '#'}" target="_blank" rel="noopener noreferrer" class="btn" title="Open in GitLab">
          GitLab ↗
        </a>
      </div>
    </div>

    <div class="top-bar-row2">
      <div class="branch-flow">
        <span class="branch-pill">${escapeHtml(mr.source_branch)}</span>
        <span>→</span>
        <span class="branch-pill">${escapeHtml(mr.target_branch)}</span>
        <span style="margin-left: 10px; color: var(--text-dim);">
          by <strong style="color: var(--text-main);">${escapeHtml(mr.author?.name || mr.author?.username || 'Unknown')}</strong>
        </span>
      </div>

      <div class="stats-summary">
        <span class="stat-files">${stats.totalFiles} files changed</span>
        <span class="stat-add">+${stats.totalAdditions}</span>
        <span class="stat-del">-${stats.totalDeletions}</span>
      </div>
    </div>
  </header>

  <!-- Navigation Tabs -->
  <nav class="tabs-bar">
    <div class="tab-item active" data-tab="changes">
      Changes <span class="tab-counter">${stats.totalFiles}</span>
    </div>
    <div class="tab-item" data-tab="overview">
      Overview
    </div>
    ${formattedDiscussions.length > 0 ? `
    <div class="tab-item" data-tab="discussions">
      Discussions <span class="tab-counter">${formattedDiscussions.length}</span>
    </div>` : ''}
  </nav>

  <!-- Main Body -->
  <main class="main-layout">
    <!-- File Sidebar -->
    <aside id="file-sidebar" class="file-sidebar">
      <div class="sidebar-header">
        <input type="text" id="file-filter-input" class="sidebar-search-box" placeholder="Filter files (e.g. .ts, auth)...">
        <div>
          <div class="review-progress">
            <span>Reviewed Progress</span>
            <span id="reviewed-count">0 / ${stats.totalFiles}</span>
          </div>
          <div class="progress-bar-track">
            <div id="progress-bar-fill" class="progress-bar-fill"></div>
          </div>
        </div>
      </div>

      <ul id="file-tree-list" class="file-tree-list">
        ${stats.files.map((file, idx) => `
          <li class="file-tree-item" data-file-index="${idx}" data-filename="${escapeHtml(file.name)}" title="${escapeHtml(file.name)}">
            <input type="checkbox" class="file-reviewed-checkbox" title="Mark as reviewed">
            <span class="file-status-badge status-${file.status}">${file.status}</span>
            <span class="file-tree-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="file-tree-diff-stats">
              ${file.added > 0 ? `<span class="stat-add">+${file.added}</span>` : ''}
              ${file.deleted > 0 ? `<span class="stat-del">-${file.deleted}</span>` : ''}
            </span>
          </li>
        `).join('')}
      </ul>
    </aside>

    <!-- Resizer Handle -->
    <div id="sidebar-resizer" class="sidebar-resizer" title="Drag to resize sidebar (double-click to reset)"></div>

    <!-- Content Canvas -->
    <section class="content-canvas">
      <!-- Changes Tab -->
      <div id="tab-content-changes">
        <div id="diff-output-container"></div>
      </div>

      <!-- Overview Tab -->
      <div id="tab-content-overview" style="display: none;">
        <div class="overview-container">
          <h2>${escapeHtml(mr.title)}</h2>
          <hr style="border: 0; border-top: 1px solid var(--border-default); margin: 16px 0;">
          <div class="markdown-body">
            ${descriptionHtml}
          </div>
        </div>
      </div>

      <!-- Discussions Tab -->
      ${formattedDiscussions.length > 0 ? `
      <div id="tab-content-discussions" style="display: none;">
        <div class="discussions-container">
          ${formattedDiscussions.map((d, dIdx) => `
            <div class="discussion-card">
              ${d.notes.map(n => `
                <div class="discussion-header">
                  <strong>${escapeHtml(n.author?.name || 'User')}</strong>
                  <span style="color: var(--text-dim);">@${escapeHtml(n.author?.username || '')}</span>
                  <span style="margin-left: auto; color: var(--text-dim); font-size: 11px;">${new Date(n.createdAt).toLocaleString()}</span>
                </div>
                <div class="discussion-body markdown-body">
                  ${n.bodyHtml}
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </div>` : ''}
    </section>
  </main>

  <!-- Embedded Diff2Html Standalone Script -->
  <script>
    ${DIFF2HTML_JS}
  </script>

  <!-- Interactive Client Controller -->
  <script>
    (function () {
      const defaultRawDiff = ${safeJson(rawDiff)};
      const filesMeta = ${safeJson(stats.files)};
      const imageDiffs = ${safeJson(imageDiffs || {})};

      let currentOutputFormat = 'side-by-side';
      let diffUiInstance = null;

      // Pure Dark Mode Diff Rendering with Syntax Highlighting
      function renderDiffs(format) {
        const container = document.getElementById('diff-output-container');
        container.innerHTML = '';

        if (!defaultRawDiff || defaultRawDiff.trim().length === 0) {
          container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-dim);">No changes found in this Merge Request.</div>';
          return;
        }

        diffUiInstance = new Diff2HtmlUI(container, defaultRawDiff, {
          drawFileList: false,
          matching: 'words',
          outputFormat: format,
          colorScheme: 'dark',
          highlight: true,
          renderNothingWhenEmpty: false,
          highlightLanguages: {
            'php': 'php',
            'phtml': 'php',
            'blade.php': 'php',
            'inc': 'php'
          }
        });

        diffUiInstance.draw();
        diffUiInstance.highlightCode();

        enhanceFileHeaders();
        renderImageDiffs();
      }

      function enhanceFileHeaders() {
        const fileWrappers = document.querySelectorAll('.d2h-file-wrapper');
        fileWrappers.forEach((wrapper, index) => {
          const header = wrapper.querySelector('.d2h-file-header');
          if (!header) return;

          if (header.querySelector('.file-actions-container')) return;

          const fileNameEl = wrapper.querySelector('.d2h-file-name');
          const fileName = fileNameEl ? fileNameEl.innerText.trim() : (filesMeta[index]?.name || '');

          const actionContainer = document.createElement('div');
          actionContainer.className = 'file-actions-container';
          actionContainer.style.display = 'flex';
          actionContainer.style.gap = '8px';
          actionContainer.style.alignItems = 'center';

          // Copy Path Button
          const copyPathBtn = document.createElement('button');
          copyPathBtn.className = 'file-actions-btn';
          copyPathBtn.innerText = 'Copy Path';
          copyPathBtn.onclick = function (e) {
            e.stopPropagation();
            if (fileName) {
              navigator.clipboard.writeText(fileName).then(() => {
                copyPathBtn.innerText = 'Copied!';
                setTimeout(() => copyPathBtn.innerText = 'Copy Path', 1500);
              });
            }
          };

          // Collapse Button
          const collapseBtn = document.createElement('button');
          collapseBtn.className = 'file-actions-btn';
          collapseBtn.innerText = 'Collapse';
          collapseBtn.onclick = function (e) {
            e.stopPropagation();
            const diffContent = wrapper.querySelector('.d2h-files-diff, .d2h-file-diff');
            if (diffContent) {
              if (diffContent.style.display === 'none') {
                diffContent.style.display = '';
                collapseBtn.innerText = 'Collapse';
              } else {
                diffContent.style.display = 'none';
                collapseBtn.innerText = 'Expand';
              }
            }
          };

          actionContainer.appendChild(copyPathBtn);
          actionContainer.appendChild(collapseBtn);
          header.appendChild(actionContainer);
        });
      }

      function renderImageDiffs() {
        const fileWrappers = document.querySelectorAll('.d2h-file-wrapper');
        fileWrappers.forEach((wrapper, index) => {
          const fileMeta = filesMeta[index];
          const fileName = fileMeta?.name;
          if (!fileName || !imageDiffs[fileName]) return;

          const imgData = imageDiffs[fileName];
          const diffContainer = wrapper.querySelector('.d2h-files-diff, .d2h-file-diff');
          if (!diffContainer) return;

          diffContainer.innerHTML = '';
          const imageDiffEl = createImageDiffElement(imgData, fileName);
          diffContainer.appendChild(imageDiffEl);
        });
      }

      function createImageDiffElement(imgData, fileName) {
        const root = document.createElement('div');
        root.className = 'image-diff-wrapper';

        const toolbar = document.createElement('div');
        toolbar.className = 'image-diff-toolbar';

        const statusMap = {
          'A': { label: 'Added Image', cls: 'added' },
          'D': { label: 'Deleted Image', cls: 'deleted' },
          'M': { label: 'Modified Image', cls: 'modified' },
          'R': { label: 'Renamed Image', cls: 'modified' }
        };
        const statusInfo = statusMap[imgData.status] || { label: 'Image Diff', cls: 'modified' };

        const leftMeta = document.createElement('div');
        leftMeta.style.display = 'flex';
        leftMeta.style.alignItems = 'center';
        leftMeta.style.gap = '8px';
        const safeName = (fileName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        leftMeta.innerHTML = '<span class="image-diff-badge-status ' + statusInfo.cls + '">' + statusInfo.label + '</span><span style="font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-muted);">' + safeName + '</span>';
        toolbar.appendChild(leftMeta);

        const content = document.createElement('div');
        content.className = 'image-diff-content';

        function createPreviewCard(src, labelText, isDeleted) {
          const pane = document.createElement('div');
          pane.className = 'image-diff-pane';
          if (labelText) {
            const title = document.createElement('div');
            title.className = 'image-pane-title';
            title.innerHTML = labelText;
            pane.appendChild(title);
          }

          const canvas = document.createElement('div');
          canvas.className = 'image-canvas-checkerboard';

          if (src) {
            const img = document.createElement('img');
            img.className = 'image-diff-preview' + (isDeleted ? ' image-deleted' : '');
            img.src = src;
            img.alt = fileName;
            img.title = 'Click to toggle zoom (1:1)';
            img.onclick = () => img.classList.toggle('zoomed');

            const meta = document.createElement('div');
            meta.className = 'image-diff-meta';
            meta.innerText = 'Calculating dimensions...';
            img.onload = () => {
              meta.innerText = img.naturalWidth + ' × ' + img.naturalHeight + ' px';
            };

            canvas.appendChild(img);
            pane.appendChild(canvas);
            pane.appendChild(meta);
          } else {
            canvas.innerHTML = '<span style="color: var(--text-dim); font-size: 12px;">(No image preview available)</span>';
            pane.appendChild(canvas);
          }

          return pane;
        }

        if (imgData.status === 'A') {
          content.appendChild(createPreviewCard(imgData.afterUrl, ''));
        } else if (imgData.status === 'D') {
          content.appendChild(createPreviewCard(imgData.beforeUrl, '', true));
        } else {
          if (imgData.beforeUrl && imgData.afterUrl) {
            const viewModes = document.createElement('div');
            viewModes.className = 'image-diff-view-modes';
            viewModes.innerHTML = '<button class="image-diff-view-btn active" data-view="2up">2-Up</button><button class="image-diff-view-btn" data-view="swipe">Swipe</button><button class="image-diff-view-btn" data-view="onion">Onion Skin</button>';
            toolbar.appendChild(viewModes);

            const displayContainer = document.createElement('div');
            content.appendChild(displayContainer);

            function showView(viewType) {
              displayContainer.innerHTML = '';
              if (viewType === '2up') {
                const grid = document.createElement('div');
                grid.className = 'image-diff-2up';
                grid.appendChild(createPreviewCard(imgData.beforeUrl, '<span class="status-D">− Before</span>', true));
                grid.appendChild(createPreviewCard(imgData.afterUrl, '<span class="status-A">+ After</span>'));
                displayContainer.appendChild(grid);
              } else if (viewType === 'swipe') {
                const swipeContainer = document.createElement('div');
                swipeContainer.className = 'image-canvas-checkerboard';
                swipeContainer.style.flexDirection = 'column';
                swipeContainer.innerHTML = '<div class="image-diff-swipe-wrapper"><div class="image-diff-swipe-after"><img src="' + imgData.afterUrl + '" alt="After" /></div><div class="image-diff-swipe-before" style="width: 50%;"><img src="' + imgData.beforeUrl + '" alt="Before" /></div></div><input type="range" min="0" max="100" value="50" class="image-diff-slider-input" />';
                const range = swipeContainer.querySelector('.image-diff-slider-input');
                const beforePane = swipeContainer.querySelector('.image-diff-swipe-before');
                range.oninput = () => {
                  beforePane.style.width = range.value + '%';
                };
                displayContainer.appendChild(swipeContainer);
              } else if (viewType === 'onion') {
                const onionContainer = document.createElement('div');
                onionContainer.className = 'image-canvas-checkerboard';
                onionContainer.style.flexDirection = 'column';
                onionContainer.innerHTML = '<div class="image-diff-onion-wrapper"><img src="' + imgData.beforeUrl + '" alt="Before" style="max-height: 520px; display: block;" /><div class="image-diff-onion-after" style="opacity: 0.5;"><img src="' + imgData.afterUrl + '" alt="After" /></div></div><input type="range" min="0" max="100" value="50" class="image-diff-onion-slider" />';
                const range = onionContainer.querySelector('.image-diff-onion-slider');
                const afterPane = onionContainer.querySelector('.image-diff-onion-after');
                range.oninput = () => {
                  afterPane.style.opacity = (range.value / 100);
                };
                displayContainer.appendChild(onionContainer);
              }
            }

            viewModes.querySelectorAll('.image-diff-view-btn').forEach(btn => {
              btn.onclick = () => {
                viewModes.querySelectorAll('.image-diff-view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                showView(btn.getAttribute('data-view'));
              };
            });

            showView('2up');
          } else {
            const fallbackSrc = imgData.afterUrl || imgData.beforeUrl;
            content.appendChild(createPreviewCard(fallbackSrc, ''));
          }
        }

        root.appendChild(toolbar);
        root.appendChild(content);
        return root;
      }

      // Format toggling (Split vs Unified)
      const btnSideBySide = document.getElementById('btn-side-by-side');
      const btnLineByLine = document.getElementById('btn-line-by-line');

      btnSideBySide.onclick = () => {
        if (currentOutputFormat === 'side-by-side') return;
        currentOutputFormat = 'side-by-side';
        btnSideBySide.classList.add('active');
        btnLineByLine.classList.remove('active');
        renderDiffs('side-by-side');
      };

      btnLineByLine.onclick = () => {
        if (currentOutputFormat === 'line-by-line') return;
        currentOutputFormat = 'line-by-line';
        btnLineByLine.classList.add('active');
        btnSideBySide.classList.remove('active');
        renderDiffs('line-by-line');
      };

      // Resizable Sidebar Controller
      const sidebar = document.getElementById('file-sidebar');
      const resizer = document.getElementById('sidebar-resizer');
      const DEFAULT_SIDEBAR_WIDTH = 320;

      // Restore saved width from localStorage
      try {
        const savedWidth = parseInt(localStorage.getItem('mr-viewer-sidebar-width'), 10);
        if (savedWidth && savedWidth >= 180 && savedWidth <= window.innerWidth * 0.75) {
          sidebar.style.width = savedWidth + 'px';
        }
      } catch (e) {}

      let isDragging = false;
      let startX = 0;
      let startWidth = 0;

      resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        document.body.classList.add('is-resizing');
        resizer.classList.add('is-resizing');
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const diff = e.clientX - startX;
        let newWidth = startWidth + diff;
        const minW = 200;
        const maxW = Math.floor(window.innerWidth * 0.75);
        if (newWidth < minW) newWidth = minW;
        if (newWidth > maxW) newWidth = maxW;

        sidebar.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.classList.remove('is-resizing');
        resizer.classList.remove('is-resizing');
        try {
          const currentW = parseInt(sidebar.style.width, 10);
          if (currentW) {
            localStorage.setItem('mr-viewer-sidebar-width', currentW);
          }
        } catch (e) {}
      });

      // Double-click resizer to reset to default 320px
      resizer.addEventListener('dblclick', () => {
        sidebar.style.width = DEFAULT_SIDEBAR_WIDTH + 'px';
        try {
          localStorage.setItem('mr-viewer-sidebar-width', DEFAULT_SIDEBAR_WIDTH);
        } catch (e) {}
      });

      // Toggle Sidebar
      document.getElementById('btn-toggle-sidebar').onclick = () => {
        sidebar.classList.toggle('collapsed');
      };

      // Tab Switching
      const tabItems = document.querySelectorAll('.tab-item');
      tabItems.forEach(tab => {
        tab.onclick = () => {
          tabItems.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');

          const tabName = tab.getAttribute('data-tab');
          document.getElementById('tab-content-changes').style.display = tabName === 'changes' ? '' : 'none';
          document.getElementById('tab-content-overview').style.display = tabName === 'overview' ? '' : 'none';
          const discContent = document.getElementById('tab-content-discussions');
          if (discContent) {
            discContent.style.display = tabName === 'discussions' ? '' : 'none';
          }
        };
      });

      // Sidebar jumping to diff
      const fileTreeItems = document.querySelectorAll('.file-tree-item');
      fileTreeItems.forEach(item => {
        item.onclick = (e) => {
          if (e.target.tagName === 'INPUT') return;
          const index = parseInt(item.getAttribute('data-file-index'), 10);
          const wrappers = document.querySelectorAll('.d2h-file-wrapper');
          if (wrappers[index]) {
            fileTreeItems.forEach(f => f.classList.remove('active'));
            item.classList.add('active');
            wrappers[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
            const diffContent = wrappers[index].querySelector('.d2h-files-diff, .d2h-file-diff');
            if (diffContent && diffContent.style.display === 'none') {
              diffContent.style.display = '';
            }
          }
        };
      });

      // File Search Filter
      const searchInput = document.getElementById('file-filter-input');
      searchInput.oninput = () => {
        const query = searchInput.value.toLowerCase().trim();
        fileTreeItems.forEach(item => {
          const filename = item.getAttribute('data-filename').toLowerCase();
          item.style.display = filename.includes(query) ? '' : 'none';
        });
      };

      // Reviewed Checkboxes
      const checkboxes = document.querySelectorAll('.file-reviewed-checkbox');
      const progressCount = document.getElementById('reviewed-count');
      const progressFill = document.getElementById('progress-bar-fill');

      function updateProgress() {
        let count = 0;
        checkboxes.forEach((cb, i) => {
          if (cb.checked) {
            count++;
            fileTreeItems[i].classList.add('reviewed');
          } else {
            fileTreeItems[i].classList.remove('reviewed');
          }
        });
        progressCount.innerText = count + ' / ' + checkboxes.length;
        const pct = checkboxes.length > 0 ? (count / checkboxes.length) * 100 : 0;
        progressFill.style.width = pct + '%';
      }

      checkboxes.forEach(cb => cb.onchange = updateProgress);

      // Initial Render
      renderDiffs(currentOutputFormat);
    })();
  </script>
</body>
</html>`;
}

/**
 * Escapes HTML characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
