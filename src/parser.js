/**
 * Parses a GitLab MR URL or reference into host, project, and MR IID.
 * 
 * Supports:
 * - https://gitlab.com/group/subgroup/project/-/merge_requests/42
 * - https://gitlab.com/group/project/merge_requests/42/diffs
 * - https://self-hosted.gitlab.domain/group/project/-/merge_requests/10#note_1
 * - group/project!42 (when default host is configured)
 * 
 * @param {string} input - User input string
 * @param {string} [defaultHost='https://gitlab.com'] - Default host if none specified
 * @returns {{ host: string, projectPath: string, projectEncoded: string, mrIid: number, fullUrl: string }}
 */
export function parseGitLabInput(input, defaultHost = 'https://gitlab.com') {
  if (!input || typeof input !== 'string') {
    throw new Error('Please provide a valid GitLab Merge Request URL.');
  }

  const cleaned = input.trim();

  // Check if input is a short reference like: group/project!123 or group/subgroup/project!123
  const shortRefMatch = cleaned.match(/^([a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)+)[!#](\d+)$/);
  if (shortRefMatch) {
    const projectPath = shortRefMatch[1];
    const mrIid = parseInt(shortRefMatch[2], 10);
    const host = defaultHost.replace(/\/+$/, '');
    return {
      host,
      projectPath,
      projectEncoded: encodeURIComponent(projectPath),
      mrIid,
      fullUrl: `${host}/${projectPath}/-/merge_requests/${mrIid}`
    };
  }

  // Parse as URL
  let parsedUrl;
  try {
    parsedUrl = new URL(cleaned);
  } catch {
    // If not a valid URL directly, try prepending https:// if it looks like a domain
    if (cleaned.includes('/') && cleaned.includes('merge_requests')) {
      try {
        parsedUrl = new URL('https://' + cleaned);
      } catch {
        throw new Error(`Invalid URL format: "${cleaned}"`);
      }
    } else {
      throw new Error(`Invalid URL format: "${cleaned}"`);
    }
  }

  const host = parsedUrl.origin;
  const pathname = parsedUrl.pathname;

  // Pattern matches: /group/subgroup/repo/-/merge_requests/123 or /group/repo/merge_requests/123
  const mrMatch = pathname.match(/^\/(.+?)(?:\/-)?\/merge_requests\/(\d+)(?:\/.*)?$/);

  if (!mrMatch) {
    throw new Error(
      `Could not recognize a GitLab Merge Request from: "${cleaned}"\n` +
      `Expected format: https://gitlab.com/<group>/<project>/-/merge_requests/<id>`
    );
  }

  const projectPath = mrMatch[1].replace(/^\/+|\/+$/g, '');
  const mrIid = parseInt(mrMatch[2], 10);

  return {
    host,
    projectPath,
    projectEncoded: encodeURIComponent(projectPath),
    mrIid,
    fullUrl: `${host}/${projectPath}/-/merge_requests/${mrIid}`
  };
}
