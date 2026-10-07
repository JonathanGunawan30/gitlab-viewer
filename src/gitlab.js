import axios from 'axios';

/**
 * Creates an Axios instance with proper headers and error handling.
 * @param {string} token
 * @returns {import('axios').AxiosInstance}
 */
function createClient(token) {
  return axios.create({
    headers: {
      'PRIVATE-TOKEN': token,
      'User-Agent': 'GitLab-Viewer-CLI/1.0'
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

/**
 * Fetches all merge request data (info, diffs, discussions, and full file contents for context expansion).
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
  const apiBase = `${host.replace(/\/+$/, '')}/api/v4/projects/${projectEncoded}/merge_requests/${mrIid}`;

  // 1. Fetch MR Details
  let mrData;
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
    throw new Error(`GitLab API Error: ${err.message} (${err.response?.status || 'network error'})`);
  }

  // 2. Fetch Changes / Diffs
  let rawDiff = '';
  let changesList = [];

  try {
    const rawRes = await client.get(`${apiBase}/raw_diff`, { responseType: 'text' });
    if (typeof rawRes.data === 'string' && rawRes.data.trim().length > 0) {
      rawDiff = rawRes.data;
    }
  } catch {
    // fallback if raw_diff is unavailable
  }

  try {
    const changesRes = await client.get(`${apiBase}/changes`);
    if (changesRes.data && Array.isArray(changesRes.data.changes)) {
      changesList = changesRes.data.changes;
      if (!rawDiff) {
        rawDiff = convertChangesToUnifiedDiff(changesList);
      }
    }
  } catch {
    try {
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 5) {
        const diffsRes = await client.get(`${apiBase}/diffs`, {
          params: { per_page: 100, page }
        });
        const batch = diffsRes.data || [];
        if (batch.length === 0) break;
        changesList.push(...batch);
        if (batch.length < 100) hasMore = false;
        page++;
      }
      if (!rawDiff && changesList.length > 0) {
        rawDiff = convertChangesToUnifiedDiff(changesList);
      }
    } catch {
      // ignore
    }
  }

  // 3. Fetch Discussions (Comments / Notes)
  let discussions = [];
  try {
    const discRes = await client.get(`${apiBase}/discussions`, {
      params: { per_page: 100 }
    });
    discussions = discRes.data || [];
  } catch {
    // ignore
  }

  // 4. Fetch Full File Contents for Context Expansion (Enables viewing code above/below & full files)
  const fileContents = {};
  const baseSha = mrData.diff_refs?.base_sha || mrData.target_branch;
  const headSha = mrData.diff_refs?.head_sha || mrData.source_branch;

  if (changesList.length > 0 && (baseSha || headSha)) {
    if (typeof onProgress === 'function') {
      onProgress('Fetching full file contexts for lines expansion...');
    }

    const fetchTasks = changesList.map(async (change) => {
      const filePath = change.new_path || change.old_path;
      fileContents[filePath] = {
        oldPath: change.old_path,
        newPath: change.new_path,
        isNew: Boolean(change.new_file),
        isDeleted: Boolean(change.deleted_file),
        isRenamed: Boolean(change.renamed_file),
        diffChunk: change.diff || '',
        baseContent: null,
        headContent: null
      };

      const promises = [];

      // Fetch base content (before changes) if not a brand-new file
      if (!change.new_file && baseSha && change.old_path) {
        promises.push(
          client.get(
            `${host.replace(/\/+$/, '')}/api/v4/projects/${projectEncoded}/repository/files/${encodeURIComponent(change.old_path)}/raw`,
            { params: { ref: baseSha }, responseType: 'text', timeout: 15000 }
          ).then(res => {
            if (typeof res.data === 'string' && res.data.length < 2000000) {
              fileContents[filePath].baseContent = res.data;
            }
          }).catch(() => {})
        );
      }

      // Fetch head content (after changes) if not a deleted file
      if (!change.deleted_file && headSha && change.new_path) {
        promises.push(
          client.get(
            `${host.replace(/\/+$/, '')}/api/v4/projects/${projectEncoded}/repository/files/${encodeURIComponent(change.new_path)}/raw`,
            { params: { ref: headSha }, responseType: 'text', timeout: 15000 }
          ).then(res => {
            if (typeof res.data === 'string' && res.data.length < 2000000) {
              fileContents[filePath].headContent = res.data;
            }
          }).catch(() => {})
        );
      }

      await Promise.allSettled(promises);
    });

    await Promise.allSettled(fetchTasks);
  }

  return {
    mr: mrData,
    rawDiff,
    changes: changesList,
    discussions,
    fileContents
  };
}
