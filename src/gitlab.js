import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { calculateStats } from './generator.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Creates an Axios instance with proper headers and error handling.
 * @param {string} token
 * @returns {import('axios').AxiosInstance}
 */
function createClient(token) {
  return axios.create({
    headers: {
      'PRIVATE-TOKEN': token,
      'User-Agent': `GitLab-Viewer-CLI/${pkg.version || '1.0.0'}`
    },
    timeout: 30000
  });
}

/**
 * Reconstructs standard git unified diff string from GitLab change/diff objects.
 * @param {Array<any>} changes
 * @returns {string}
 */
export function convertChangesToUnifiedDiff(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return '';
  }

  return changes.map(change => {
    const oldPath = change.old_path || change.new_path;
    const newPath = change.new_path || change.old_path;
    let header = `diff --git a/${oldPath} b/${newPath}\n`;

    if (change.new_file) {
      header += `new file mode ${change.b_mode || '100644'}\n`;
      header += `--- /dev/null\n`;
      header += `+++ b/${newPath}\n`;
    } else if (change.deleted_file) {
      header += `deleted file mode ${change.a_mode || '100644'}\n`;
      header += `--- a/${oldPath}\n`;
      header += `+++ /dev/null\n`;
    } else if (change.renamed_file) {
      header += `similarity index 100%\n`;
      header += `rename from ${oldPath}\n`;
      header += `rename to ${newPath}\n`;
      header += `--- a/${oldPath}\n`;
      header += `+++ b/${newPath}\n`;
    } else {
      header += `--- a/${oldPath}\n`;
      header += `+++ b/${newPath}\n`;
    }

    const diffBody = change.diff || '';
    return header + diffBody + (diffBody.endsWith('\n') ? '' : '\n');
  }).join('\n');
}

const MAX_PAGES = 200;

/**
 * Fetches all discussion notes across all pages.
 * @param {import('axios').AxiosInstance} client
 * @param {string} apiBase
 * @param {function} [onProgress]
 * @returns {Promise<{ discussions: Array<any>, hasPartialDiscussions: boolean }>}
 */
export async function fetchAllDiscussions(client, apiBase, onProgress) {
  const discussions = [];
  let page = 1;
  let hasMore = true;
  let hasPartialDiscussions = false;

  while (hasMore && page <= MAX_PAGES) {
    try {
      onProgress?.(`Fetching discussions (page ${page})...`);
      const discRes = await client.get(`${apiBase}/discussions`, {
        params: { per_page: 100, page }
      });
      const batch = discRes.data || [];
      if (!Array.isArray(batch) || batch.length === 0) break;
      discussions.push(...batch);

      const nextPage = discRes.headers?.['x-next-page'];
      if (nextPage && nextPage.trim()) {
        page = parseInt(nextPage, 10);
      } else if (batch.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    } catch {
      if (discussions.length > 0 || page > 1) {
        hasPartialDiscussions = true;
      }
      break;
    }
  }

  if (page > MAX_PAGES && hasMore) {
    hasPartialDiscussions = true;
  }

  return { discussions, hasPartialDiscussions };
}

/**
 * Fetches MR diff data using raw_diffs, paginated /diffs, or legacy /changes fallback.
 * @param {import('axios').AxiosInstance} client
 * @param {string} apiBase
 * @param {object} mrData
 * @param {function} [onProgress]
 * @returns {Promise<{ rawDiff: string, changes: Array<any>, hasOverflow: boolean }>}
 */
export async function fetchDiffsData(client, apiBase, mrData, onProgress) {
  let rawDiff = '';
  let changesList = [];
  let hasOverflow = Boolean(
    mrData?.overflow ||
    (typeof mrData?.changes_count === 'string' && mrData.changes_count.includes('+'))
  );

  onProgress?.('Fetching raw diffs...');
  try {
    const rawRes = await client.get(`${apiBase}/raw_diffs`, { responseType: 'text' });
    if (typeof rawRes.data === 'string' && rawRes.data.trim().length > 0) {
      rawDiff = rawRes.data;
      if (rawDiff.includes('Diffs were truncated') || rawDiff.includes('diff too large')) {
        hasOverflow = true;
      }
    }
  } catch {
    // /raw_diffs endpoint unavailable or failed
  }

  // If raw_diffs succeeded, return immediately
  if (rawDiff) {
    return { rawDiff, changes: changesList, hasOverflow };
  }

  // If raw_diffs unavailable, fetch all pages from /diffs with MAX_PAGES guard
  try {
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= MAX_PAGES) {
      onProgress?.(`Fetching diffs (page ${page})...`);
      const diffsRes = await client.get(`${apiBase}/diffs`, {
        params: { per_page: 100, page }
      });
      const batch = diffsRes.data || [];
      if (!Array.isArray(batch) || batch.length === 0) break;
      changesList.push(...batch);

      for (const item of batch) {
        if (item.too_large || item.collapsed) {
          hasOverflow = true;
        }
      }

      const nextPage = diffsRes.headers?.['x-next-page'];
      if (nextPage && nextPage.trim()) {
        page = parseInt(nextPage, 10);
      } else if (batch.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    if (page > MAX_PAGES && hasMore) {
      hasOverflow = true;
    }

    if (changesList.length > 0) {
      rawDiff = convertChangesToUnifiedDiff(changesList);
    }
  } catch {
    // Fallback to /changes for older GitLab instances
    try {
      onProgress?.('Fetching changes fallback...');
      const changesRes = await client.get(`${apiBase}/changes`, {
        params: { access_raw_diffs: true }
      });
      if (changesRes.data && Array.isArray(changesRes.data.changes)) {
        changesList = changesRes.data.changes;
        rawDiff = convertChangesToUnifiedDiff(changesList);
        if (changesRes.data.overflow) {
          hasOverflow = true;
        }
      }
    } catch {
      // ignore
    }
  }

  return { rawDiff, changes: changesList, hasOverflow };
}

/**
 * Fetches all merge request data (info, diffs, discussions).
 * 
 * @param {object} params
 * @param {string} params.host
 * @param {string} params.projectEncoded
 * @param {number} params.mrIid
 * @param {string} params.token
 * @param {function} [onProgress] - Optional progress callback
 */
export async function fetchMergeRequestData({ host, projectEncoded, mrIid, token, onProgress }) {
  const client = createClient(token);
  const cleanHost = host.replace(/\/+$/, '');
  const apiBase = `${cleanHost}/api/v4/projects/${projectEncoded}/merge_requests/${mrIid}`;

  // 1. Fetch MR Details
  let mrData;
  onProgress?.(`Connecting to ${cleanHost} for MR !${mrIid}...`);
  try {
    const res = await client.get(apiBase);
    mrData = res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      throw new Error(
        'GitLab API Error: 401 Unauthorized.\n' +
        'Your GitLab Personal Access Token (PAT) is invalid or expired.\n' +
        'Update it using: mr-view config set-token <YOUR_TOKEN>'
      );
    }
    if (err.response?.status === 404) {
      throw new Error(
        'GitLab API Error: 404 Not Found.\n' +
        'Project or Merge Request was not found, or your token lacks permission to view this private repo.\n' +
        'Ensure the token has "read_api" or "api" scope with access to this project.'
      );
    }
    if (err.response?.status === 403) {
      throw new Error(
        'GitLab API Error: 403 Forbidden.\n' +
        'Your token does not have permission to access this Merge Request.'
      );
    }
    const sslCodes = [
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED'
    ];
    if (sslCodes.includes(err.code)) {
      throw new Error(
        `GitLab SSL Certificate Error (${err.code}).\n` +
        'If using self-hosted GitLab with an internal/custom CA, set the NODE_EXTRA_CA_CERTS environment variable.'
      );
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        `GitLab Request Timeout (${err.code}): The request to "${cleanHost}" timed out after 30 seconds.\n` +
        'Please check your network connection or VPN.'
      );
    }
    if (err.code === 'ENOTFOUND') {
      throw new Error(`GitLab Host Error: Cannot resolve domain "${cleanHost}". Please check your internet connection or host URL.`);
    }
    if (err.code === 'ECONNREFUSED') {
      throw new Error(`GitLab Connection Refused: Could not connect to "${cleanHost}".`);
    }
    throw new Error(`GitLab API Error: ${err.message} (${err.response?.status || err.code || 'network error'})`);
  }

  // 2. Fetch Diffs and Discussions in parallel
  onProgress?.('Fetching diffs and discussions in parallel...');
  const [diffResult, discussionsResult] = await Promise.all([
    fetchDiffsData(client, apiBase, mrData, onProgress),
    fetchAllDiscussions(client, apiBase, onProgress)
  ]);

  // 3. Pre-fetch & embed markdown images in description and discussions
  if (mrData.description) {
    onProgress?.('Embedding images in MR description...');
    mrData.description = await embedMarkdownImages(client, cleanHost, projectEncoded, mrData.description, onProgress);
  }

  if (Array.isArray(discussionsResult.discussions) && discussionsResult.discussions.length > 0) {
    onProgress?.('Embedding images in discussion comments...');
    for (const d of discussionsResult.discussions) {
      if (Array.isArray(d.notes)) {
        for (const n of d.notes) {
          if (n.body) {
            n.body = await embedMarkdownImages(client, cleanHost, projectEncoded, n.body);
          }
        }
      }
    }
  }

  // 4. Fetch image diff previews for image files touched in MR
  const stats = calculateStats(diffResult.rawDiff, diffResult.changes);
  const imageDiffs = await fetchImageDiffs(client, cleanHost, projectEncoded, mrData, stats.files, onProgress);

  return {
    mr: mrData,
    rawDiff: diffResult.rawDiff,
    changes: diffResult.changes,
    hasOverflow: diffResult.hasOverflow,
    discussions: discussionsResult.discussions,
    hasPartialDiscussions: discussionsResult.hasPartialDiscussions,
    imageDiffs
  };
}

export const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};

/**
 * Checks if a file path is an image based on its extension.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isImageFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath.split('?')[0]).toLowerCase();
  return Boolean(IMAGE_MIME_TYPES[ext]);
}

/**
 * Fetches raw content of a repository file as a Base64 data URI.
 * @param {import('axios').AxiosInstance} client
 * @param {string} cleanHost
 * @param {string | number} projectId
 * @param {string} filePath
 * @param {string} ref
 * @returns {Promise<string | null>}
 */
export async function fetchRawFile(client, cleanHost, projectId, filePath, ref) {
  if (!filePath || filePath === '/dev/null' || !ref) return null;
  try {
    const cleanPath = filePath.replace(/^\.?\//, '');
    const encodedPath = encodeURIComponent(cleanPath).replace(/\./g, '%2E');
    const url = `${cleanHost}/api/v4/projects/${projectId}/repository/files/${encodedPath}/raw`;
    const res = await client.get(url, {
      params: { ref },
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 15 * 1024 * 1024
    });
    const ext = path.extname(cleanPath.split('?')[0]).toLowerCase();
    const contentType = res.headers?.['content-type'] || IMAGE_MIME_TYPES[ext] || 'image/png';
    const base64 = Buffer.from(res.data).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Fetches before/after previews for all image files changed in MR.
 * @param {import('axios').AxiosInstance} client
 * @param {string} cleanHost
 * @param {string} projectEncoded
 * @param {object} mrData
 * @param {Array<any>} files
 * @param {function} [onProgress]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchImageDiffs(client, cleanHost, projectEncoded, mrData, files = [], onProgress) {
  const imageFiles = files.filter(f => isImageFile(f.name));
  if (imageFiles.length === 0) return {};

  const headRef = mrData?.diff_refs?.head_sha || mrData?.sha || mrData?.source_branch;
  const baseRef = mrData?.diff_refs?.base_sha || mrData?.target_branch;
  const sourceProject = mrData?.source_project_id || projectEncoded;
  const targetProject = mrData?.target_project_id || projectEncoded;

  const imageDiffs = {};
  const maxImages = 40;
  const toProcess = imageFiles.slice(0, maxImages);

  for (let i = 0; i < toProcess.length; i++) {
    const file = toProcess[i];
    onProgress?.(`Fetching image preview (${i + 1}/${toProcess.length}): ${file.name}...`);

    let beforeUrl = null;
    let afterUrl = null;

    if (file.status === 'A') {
      afterUrl = await fetchRawFile(client, cleanHost, sourceProject, file.newName || file.name, headRef);
    } else if (file.status === 'D') {
      beforeUrl = await fetchRawFile(client, cleanHost, targetProject, file.oldName || file.name, baseRef);
    } else {
      [beforeUrl, afterUrl] = await Promise.all([
        fetchRawFile(client, cleanHost, targetProject, file.oldName || file.name, baseRef),
        fetchRawFile(client, cleanHost, sourceProject, file.newName || file.name, headRef)
      ]);
    }

    imageDiffs[file.name] = {
      name: file.name,
      status: file.status,
      oldName: file.oldName,
      newName: file.newName,
      beforeUrl,
      afterUrl
    };
  }

  return imageDiffs;
}

/**
 * Parses markdown text, downloads referenced images using the authenticated GitLab client,
 * and inlines them as Base64 data URIs so they display offline and on private repositories.
 * 
 * @param {import('axios').AxiosInstance} client
 * @param {string} cleanHost
 * @param {string} projectEncoded
 * @param {string} markdownText
 * @param {function} [onProgress]
 * @returns {Promise<string>}
 */
export async function embedMarkdownImages(client, cleanHost, projectEncoded, markdownText, onProgress) {
  if (!markdownText || typeof markdownText !== 'string') return markdownText;

  const mdRegex = /!\[(.*?)\]\(\s*<?([^\s\)>]+)>?(?:\s+["'][^"']*?["'])?\s*\)/g;
  const htmlRegex = /<img\s+[^>]*?src=["']([^"']+)["'][^>]*>/gi;

  const foundUrls = new Set();
  let match;
  while ((match = mdRegex.exec(markdownText)) !== null) {
    if (match[2] && !match[2].startsWith('data:')) {
      foundUrls.add(match[2].trim());
    }
  }
  while ((match = htmlRegex.exec(markdownText)) !== null) {
    if (match[1] && !match[1].startsWith('data:')) {
      foundUrls.add(match[1].trim());
    }
  }

  if (foundUrls.size === 0) return markdownText;

  const projectPath = decodeURIComponent(projectEncoded);
  const cache = new Map();

  for (const rawUrl of foundUrls) {
    let resolvedUrl = rawUrl;
    let isGitLabHost = false;

    if (resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://')) {
      isGitLabHost = resolvedUrl.startsWith(cleanHost);
    } else if (resolvedUrl.startsWith('/uploads/') || resolvedUrl.startsWith('uploads/')) {
      const cleanSub = resolvedUrl.replace(/^\/?uploads\//, '');
      resolvedUrl = `${cleanHost}/${projectPath}/uploads/${cleanSub}`;
      isGitLabHost = true;
    } else if (resolvedUrl.startsWith('/')) {
      resolvedUrl = `${cleanHost}${resolvedUrl}`;
      isGitLabHost = true;
    } else {
      resolvedUrl = `${cleanHost}/${projectPath}/${resolvedUrl}`;
      isGitLabHost = true;
    }

    try {
      const getOptions = {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxContentLength: 10 * 1024 * 1024
      };
      if (!isGitLabHost) {
        getOptions.headers = { 'PRIVATE-TOKEN': undefined };
      }

      const res = await client.get(resolvedUrl, getOptions);
      const ext = path.extname(resolvedUrl.split('?')[0]).toLowerCase();
      const contentType = res.headers?.['content-type'] || IMAGE_MIME_TYPES[ext] || 'image/png';
      const base64 = Buffer.from(res.data).toString('base64');
      const dataUri = `data:${contentType};base64,${base64}`;
      cache.set(rawUrl, dataUri);
    } catch {
      // Ignore failures
    }
  }

  if (cache.size === 0) return markdownText;

  let result = markdownText;
  for (const [rawUrl, dataUri] of cache.entries()) {
    result = result.split(rawUrl).join(dataUri);
  }
  return result;
}
