import fs from 'node:fs';
import axios from 'axios';

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

  return {
    mr: mrData,
    rawDiff: diffResult.rawDiff,
    changes: diffResult.changes,
    hasOverflow: diffResult.hasOverflow,
    discussions: discussionsResult.discussions,
    hasPartialDiscussions: discussionsResult.hasPartialDiscussions
  };
}
