import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.gitlab-viewer');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Ensures the config directory exists.
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Reads configuration from ~/.gitlab-viewer/config.json
 * @returns {Record<string, any>}
 */
export function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore parse error, return defaults
  }
  return {};
}

/**
 * Saves configuration to ~/.gitlab-viewer/config.json
 * @param {Record<string, any>} updates
 */
export function saveConfig(updates) {
  ensureConfigDir();
  const current = getConfig();
  const merged = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), {
    encoding: 'utf8',
    mode: 0o600 // Read/write only by owner
  });
  return merged;
}

/**
 * Resolves token from CLI argument, env var, or stored config.
 * @param {string} [cliToken]
 * @returns {string | null}
 */
export function resolveToken(cliToken) {
  if (cliToken && cliToken.trim()) {
    return cliToken.trim();
  }
  if (process.env.GITLAB_TOKEN && process.env.GITLAB_TOKEN.trim()) {
    return process.env.GITLAB_TOKEN.trim();
  }
  const config = getConfig();
  if (config.token && config.token.trim()) {
    return config.token.trim();
  }
  return null;
}

/**
 * Resolves default host from CLI argument, env var, or stored config.
 * @param {string} [cliHost]
 * @returns {string}
 */
export function resolveHost(cliHost) {
  if (cliHost && cliHost.trim()) {
    return cliHost.trim().replace(/\/+$/, '');
  }
  if (process.env.GITLAB_HOST && process.env.GITLAB_HOST.trim()) {
    return process.env.GITLAB_HOST.trim().replace(/\/+$/, '');
  }
  const config = getConfig();
  if (config.host && config.host.trim()) {
    return config.host.trim().replace(/\/+$/, '');
  }
  return 'https://gitlab.com';
}
