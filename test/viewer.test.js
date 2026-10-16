import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, calculateStats, generateViewerHtml } from '../src/generator.js';
import { parseGitLabInput } from '../src/parser.js';
import {
  convertChangesToUnifiedDiff,
  fetchDiffsData,
  fetchAllDiscussions,
  isImageFile,
  fetchRawFile,
  fetchImageDiffs,
  embedMarkdownImages
} from '../src/gitlab.js';

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

  test('resolves relative uploads/ without leading slash to absolute GitLab URL', () => {
    const md = '![Screenshot](uploads/abcd1234ef/image.png)';
    const clean = renderMarkdown(md, 'https://gitlab.example.com/org/project/-/merge_requests/42');
    assert.match(clean, /src="https:\/\/gitlab\.example\.com\/org\/project\/uploads\/abcd1234ef\/image\.png"/);
  });

  test('preserves data: image URIs in rendered markdown', () => {
    const md = '![Embedded](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)';
    const clean = renderMarkdown(md);
    assert.match(clean, /src="data:image\/png;base64,/);
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

describe('Image Diffs & Asset Embedding', () => {
  test('isImageFile correctly identifies image formats', () => {
    assert.equal(isImageFile('logo.png'), true);
    assert.equal(isImageFile('photo.JPG'), true);
    assert.equal(isImageFile('banner.jpeg'), true);
    assert.equal(isImageFile('anim.gif'), true);
    assert.equal(isImageFile('image.webp'), true);
    assert.equal(isImageFile('icon.svg'), true);
    assert.equal(isImageFile('favicon.ico'), true);
    assert.equal(isImageFile('path/to/nested/asset.png?v=123'), true);

    assert.equal(isImageFile('index.js'), false);
    assert.equal(isImageFile('style.css'), false);
    assert.equal(isImageFile('README.md'), false);
    assert.equal(isImageFile(''), false);
    assert.equal(isImageFile(null), false);
  });

  test('fetchRawFile retrieves repository file and converts to data URI', async () => {
    const mockClient = {
      get: async (url, opts) => {
        assert.match(url, /\/repository\/files\/public%2Fimage%2Epng\/raw/);
        assert.equal(opts.params.ref, 'main');
        return {
          data: Buffer.from('fake-png-binary-content'),
          headers: { 'content-type': 'image/png' }
        };
      }
    };

    const dataUri = await fetchRawFile(mockClient, 'https://gitlab.com', 'group%2Frepo', 'public/image.png', 'main');
    assert.match(dataUri, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(dataUri.split(',')[1], 'base64').toString(), 'fake-png-binary-content');
  });

  test('fetchRawFile returns null when ref is missing or path is /dev/null', async () => {
    const resNullPath = await fetchRawFile({}, 'https://gitlab.com', '1', '/dev/null', 'main');
    assert.equal(resNullPath, null);

    const resNoRef = await fetchRawFile({}, 'https://gitlab.com', '1', 'logo.png', '');
    assert.equal(resNoRef, null);
  });

  test('fetchImageDiffs fetches before and after previews based on status', async () => {
    const mockClient = {
      get: async (url, opts) => {
        if (url.includes('new-logo%2Epng')) {
          return {
            data: Buffer.from('new-image-bytes'),
            headers: { 'content-type': 'image/png' }
          };
        }
        if (url.includes('old-icon%2Epng')) {
          return {
            data: Buffer.from('old-image-bytes'),
            headers: { 'content-type': 'image/png' }
          };
        }
        throw new Error('Unexpected URL: ' + url);
      }
    };

    const mrData = {
      diff_refs: { head_sha: 'head123', base_sha: 'base123' },
      source_project_id: 10,
      target_project_id: 10
    };

    const files = [
      { name: 'new-logo.png', status: 'A', oldName: '/dev/null', newName: 'new-logo.png' },
      { name: 'old-icon.png', status: 'D', oldName: 'old-icon.png', newName: '/dev/null' },
      { name: 'app.js', status: 'M', oldName: 'app.js', newName: 'app.js' }
    ];

    const diffs = await fetchImageDiffs(mockClient, 'https://gitlab.com', '10', mrData, files);
    assert.ok(diffs['new-logo.png']);
    assert.equal(diffs['new-logo.png'].status, 'A');
    assert.match(diffs['new-logo.png'].afterUrl, /^data:image\/png;base64,/);
    assert.equal(diffs['new-logo.png'].beforeUrl, null);

    assert.ok(diffs['old-icon.png']);
    assert.equal(diffs['old-icon.png'].status, 'D');
    assert.match(diffs['old-icon.png'].beforeUrl, /^data:image\/png;base64,/);
    assert.equal(diffs['old-icon.png'].afterUrl, null);

    assert.equal(diffs['app.js'], undefined);
  });

  test('embedMarkdownImages inlines image URLs as Base64 data URIs', async () => {
    const mockClient = {
      get: async (url) => {
        if (url.includes('test-upload.png')) {
          return {
            data: Buffer.from('fake-upload-bytes'),
            headers: { 'content-type': 'image/png' }
          };
        }
        throw new Error('Unexpected URL: ' + url);
      }
    };

    const markdown = 'Here is a screenshot:\n![My Screenshot](/uploads/abc1234/test-upload.png)\nand inline <img src="/uploads/abc1234/test-upload.png" width="300" />';
    const embedded = await embedMarkdownImages(mockClient, 'https://gitlab.com', 'group%2Fproject', markdown);

    assert.match(embedded, /!\[My Screenshot\]\(data:image\/png;base64,/);
    assert.match(embedded, /<img src="data:image\/png;base64,/);
    assert.doesNotMatch(embedded, /\/uploads\/abc1234\/test-upload\.png/);
  });

  test('generateViewerHtml renders imageDiffs and image-canvas-checkerboard elements', () => {
    const html = generateViewerHtml({
      mr: {
        iid: 10,
        title: 'Add Assets',
        source_branch: 'feat/assets',
        target_branch: 'main',
        description: 'Updated illustrations'
      },
      rawDiff: 'diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ\n',
      changes: [{ new_file: true, new_path: 'logo.png', old_path: '/dev/null' }],
      discussions: [],
      imageDiffs: {
        'logo.png': {
          name: 'logo.png',
          status: 'A',
          beforeUrl: null,
          afterUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        }
      }
    });

    assert.match(html, /image-canvas-checkerboard/);
    assert.match(html, /renderImageDiffs/);
    assert.match(html, /imageDiffs/);
  });
});

