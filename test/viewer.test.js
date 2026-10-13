import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, calculateStats, generateViewerHtml } from '../src/generator.js';
import { parseGitLabInput } from '../src/parser.js';
import { convertChangesToUnifiedDiff, fetchDiffsData, fetchAllDiscussions } from '../src/gitlab.js';

describe('Markdown Sanitization & XSS Prevention', () => {
  test('strips dangerous <script> tags from markdown', () => {
    const malicious = 'Hello <script>alert("pwned")</script> World';
    const clean = renderMarkdown(malicious);
    assert.doesNotMatch(clean, /<script>/i);
    assert.doesNotMatch(clean, /alert/i);
    assert.match(clean, /Hello/);
    assert.match(clean, /World/);
  });

  test('strips inline event handlers like onerror and onload', () => {
    const malicious = '<img src="invalid" onerror="alert(1)">\n<a href="javascript:alert(1)">Click</a>';
    const clean = renderMarkdown(malicious);
    assert.doesNotMatch(clean, /onerror/i);
    assert.doesNotMatch(clean, /javascript:/i);
  });

  test('disallows data: scheme on links', () => {
    const malicious = '[Phish](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)';
    const clean = renderMarkdown(malicious);
    assert.doesNotMatch(clean, /href="data:/i);
  });

  test('resolves relative /uploads/ image paths to absolute GitLab URL', () => {
    const md = '![Screenshot](/uploads/abcd1234ef/image.png)';
    const clean = renderMarkdown(md, 'https://gitlab.example.com/org/project/-/merge_requests/42');
    assert.match(clean, /src="https:\/\/gitlab\.example\.com\/org\/project\/uploads\/abcd1234ef\/image\.png"/);
  });

  test('forces rel="noopener noreferrer" and target="_blank" on links', () => {
    const md = '[GitLab](https://gitlab.com)';
    const clean = renderMarkdown(md);
    assert.match(clean, /rel="noopener noreferrer"/);
    assert.match(clean, /target="_blank"/);
  });

  test('renders standard markdown elements safely', () => {
    const md = '# Title\n\n**bold** and `code`\n\n- item 1\n- item 2';
    const clean = renderMarkdown(md);
    assert.match(clean, /<h1>Title<\/h1>/);
    assert.match(clean, /<strong>bold<\/strong>/);
    assert.match(clean, /<code>code<\/code>/);
    assert.match(clean, /<li>item 1<\/li>/);
  });
});

describe('parseGitLabInput', () => {
  test('parses standard GitLab MR URL', () => {
    const parsed = parseGitLabInput('https://gitlab.com/my-org/my-repo/-/merge_requests/42');
    assert.equal(parsed.host, 'https://gitlab.com');
    assert.equal(parsed.projectPath, 'my-org/my-repo');
    assert.equal(parsed.projectEncoded, 'my-org%2Fmy-repo');
    assert.equal(parsed.mrIid, 42);
  });

  test('parses nested subgroup MR URL', () => {
    const parsed = parseGitLabInput('https://gitlab.example.com/team/subgroup/app/-/merge_requests/105');
    assert.equal(parsed.host, 'https://gitlab.example.com');
    assert.equal(parsed.projectPath, 'team/subgroup/app');
    assert.equal(parsed.mrIid, 105);
  });

  test('parses short reference group/repo!123 with default host', () => {
    const parsed = parseGitLabInput('org/backend!99', 'https://gitlab.mycorp.com');
    assert.equal(parsed.host, 'https://gitlab.mycorp.com');
    assert.equal(parsed.projectPath, 'org/backend');
    assert.equal(parsed.mrIid, 99);
  });

  test('throws descriptive error on invalid input', () => {
    assert.throws(() => parseGitLabInput(''), /Please provide a valid/);
    assert.throws(() => parseGitLabInput('https://google.com'), /Could not recognize a GitLab Merge Request/);
  });
});

describe('convertChangesToUnifiedDiff', () => {
  test('converts modified file changes to unified diff format', () => {
    const changes = [{
      old_path: 'src/index.js',
      new_path: 'src/index.js',
      diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n'
    }];
    const diff = convertChangesToUnifiedDiff(changes);
    assert.match(diff, /diff --git a\/src\/index\.js b\/src\/index\.js/);
    assert.match(diff, /--- a\/src\/index\.js/);
    assert.match(diff, /\+\+\+ b\/src\/index\.js/);
    assert.match(diff, /\+new/);
  });

  test('handles new files correctly', () => {
    const changes = [{
      new_file: true,
      new_path: 'src/new.js',
      diff: '@@ -0,0 +1 @@\n+console.log("hi");\n'
    }];
    const diff = convertChangesToUnifiedDiff(changes);
    assert.match(diff, /--- \/dev\/null/);
    assert.match(diff, /\+\+\+ b\/src\/new\.js/);
  });

  test('handles deleted files correctly', () => {
    const changes = [{
      deleted_file: true,
      old_path: 'src/old.js',
      diff: '@@ -1 +0,0 @@\n-deprecated\n'
    }];
    const diff = convertChangesToUnifiedDiff(changes);
    assert.match(diff, /--- a\/src\/old\.js/);
    assert.match(diff, /\+\+\+ \/dev\/null/);
  });
});

describe('calculateStats & generateViewerHtml', () => {
  test('calculates correct file counts and stats', () => {
    const rawDiff = `diff --git a/test.js b/test.js
index 1111111..2222222 100644
--- a/test.js
+++ b/test.js
@@ -1,2 +1,3 @@
-remove
+added 1
+added 2
`;
    const stats = calculateStats(rawDiff);
    assert.equal(stats.totalFiles, 1);
    assert.equal(stats.totalAdditions, 2);
    assert.equal(stats.totalDeletions, 1);
  });

  test('generates HTML containing draft badge when mr is draft', () => {
    const html = generateViewerHtml({
      mr: {
        iid: 1,
        title: 'Draft Feature',
        draft: true,
        state: 'opened',
        source_branch: 'feat',
        target_branch: 'main',
        description: 'WIP description'
      },
      rawDiff: '',
      changes: [],
      discussions: []
    });

    assert.match(html, /badge-status badge-draft/);
    assert.match(html, /DRAFT/);
    assert.match(html, /Content-Security-Policy/);
  });
});

describe('GitLab API Client & Pagination', () => {
  test('fetchDiffsData uses /raw_diffs endpoint on success', async () => {
    const mockClient = {
      get: async (url) => {
        if (url.endsWith('/raw_diffs')) {
          return { data: 'diff --git a/a b/b\n+hello' };
        }
        throw new Error('Unexpected call: ' + url);
      }
    };

    const res = await fetchDiffsData(mockClient, 'https://gitlab.com/api/v4/projects/1/merge_requests/1', {});
    assert.equal(res.rawDiff, 'diff --git a/a b/b\n+hello');
    assert.equal(res.hasOverflow, false);
  });

  test('fetchDiffsData falls back to paginated /diffs when /raw_diffs fails', async () => {
    const mockClient = {
      get: async (url, opts) => {
        if (url.endsWith('/raw_diffs')) {
          throw new Error('404 Not Found');
        }
        if (url.endsWith('/diffs')) {
          const page = opts.params.page;
          if (page === 1) {
            return {
              data: [{ old_path: 'a.js', new_path: 'a.js', diff: '+1' }],
              headers: { 'x-next-page': '2' }
            };
          }
          if (page === 2) {
            return {
              data: [{ old_path: 'b.js', new_path: 'b.js', diff: '+2' }],
              headers: { 'x-next-page': '' }
            };
          }
        }
        throw new Error('Unexpected call');
      }
    };

    const res = await fetchDiffsData(mockClient, 'https://gitlab.com/api/v4/projects/1/merge_requests/1', {});
    assert.match(res.rawDiff, /diff --git a\/a\.js/);
    assert.match(res.rawDiff, /diff --git a\/b\.js/);
    assert.equal(res.changes.length, 2);
  });

  test('fetchDiffsData flags overflow when changes_count contains +', async () => {
    const mockClient = {
      get: async (url) => {
        if (url.endsWith('/raw_diffs')) {
          return { data: 'diff --git a/a b/b\n+hello' };
        }
        throw new Error('404');
      }
    };

    const res = await fetchDiffsData(mockClient, 'https://gitlab.com/api/v4/projects/1/merge_requests/1', {
      changes_count: '1000+'
    });
    assert.equal(res.hasOverflow, true);
  });

  test('fetchAllDiscussions paginates across multiple pages and handles partial failure', async () => {
    const mockClient = {
      get: async (url, opts) => {
        const page = opts.params.page;
        if (page === 1) {
          return {
            data: [{ id: 'd1', notes: [] }],
            headers: { 'x-next-page': '2' }
          };
        }
        if (page === 2) {
          throw new Error('Network timeout on page 2');
        }
      }
    };

    const res = await fetchAllDiscussions(mockClient, 'https://gitlab.com/api/v4/projects/1/merge_requests/1');
    assert.equal(res.discussions.length, 1);
    assert.equal(res.hasPartialDiscussions, true);
  });
});
