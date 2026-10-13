# GitLab MR Diff Viewer (CLI)

[![GitHub](https://img.shields.io/badge/GitHub-JonathanGunawan30%2Fgitlab--viewer-blue?logo=github)](https://github.com/JonathanGunawan30/gitlab-viewer)
[![License: Unlicense](https://img.shields.io/badge/License-Unlicense-blue.svg)](https://unlicense.org/)

> **Ultra-lightweight private GitLab Merge Request diff viewer** featuring crystal-clear highlighting, zero server overhead, and 100% local privacy.

GitHub Repository: [https://github.com/JonathanGunawan30/gitlab-viewer](https://github.com/JonathanGunawan30/gitlab-viewer)

---

## Key Features

- **Crystal-Clear & Detailed Highlighting**:
  - Word-level and character-level diff highlighting (modifications stand out with crisp contrast).
  - Automatic syntax highlighting tailored to each programming language (TypeScript, JavaScript, Go, Python, Java, PHP, etc.).
  - High-contrast Dark Mode featuring crystal-clear syntax and diff highlighting.
  - Side-by-Side (Split) & Line-by-Line (Unified) instant view toggle without page reload.
- **Zero Server Overhead & 0 RAM in Background**:
  - No lingering Express server or background process keeping ports open.
  - CLI completes within 1–2 seconds, automatically opens your browser, and exits immediately (`process.exit(0)`).
- **Zero Disk Clutter**:
  - Uses a single temporary file in your system's `%TEMP%` directory that is automatically overwritten whenever you open a new MR.
- **Secure & Locally Isolated**:
  - Locked with `"private": true` to prevent accidental publishing to public npm.
  - Personal Access Tokens (PAT) are never transmitted to external servers or public networks; they are only used to query the GitLab API v4 directly.
- **File Explorer & Review Productivity**:
  - Filter and search files by filename or extension (`.ts`, `auth`, etc.).
  - *"Mark as Reviewed"* checkboxes with a real-time progress bar.
  - *Collapse / Expand* and *Copy File Path* buttons on every file header.
  - *Overview* tab (MR description with full Markdown rendering) and *Discussions* tab (review comments and threads).

---

## Installation

Clone the repository from GitHub and install/link it globally:

```bash
git clone https://github.com/JonathanGunawan30/gitlab-viewer.git
cd gitlab-viewer
npm install
npm link
```

Once linked, both the `mr-view` and `gitlab-viewer` commands will be available globally in your terminal.

---

## Usage

### 1. Save Your Personal Access Token (One-Time Setup)

Save your GitLab Personal Access Token (PAT):
```bash
mr-view config set-token glpat-xxxxxxxxxxxxxxxxxxxx
```
*(The token is stored securely in your local user directory at `~/.gitlab-viewer/config.json`)*.

To inspect your current configuration:
```bash
mr-view config show
```

Optional: Set a default GitLab host (defaults to `https://gitlab.com`):
```bash
mr-view config set-host https://gitlab.mycompany.com
```

---

### 2. Open a Merge Request

Simply run the command with your GitLab MR URL:
```bash
mr-view https://gitlab.com/group-name/repo-name/-/merge_requests/42
```

Or using the full alias:
```bash
gitlab-viewer https://gitlab.com/group-name/repo-name/-/merge_requests/42
```

Self-Hosted and Enterprise GitLab instances are fully supported:
```bash
mr-view https://gitlab.company.domain/backend/core-service/-/merge_requests/15
```

If you run `mr-view` without arguments, it will interactively prompt you for the MR URL:
```bash
mr-view
```

---

## Additional Options

```bash
# Temporarily override token for a single execution
mr-view https://gitlab.com/... -t glpat-other-token

# Save the diff to a custom HTML file path (instead of the temp preview)
mr-view https://gitlab.com/... -o ./review-mr-42.html

# Generate the HTML preview without automatically launching the browser
mr-view https://gitlab.com/... --no-open

# Specify custom GitLab host
mr-view https://gitlab.company.domain/... -H https://gitlab.company.domain
```

---

## Privacy & Security

- **Required Token Scopes**: Minimal scopes needed are `read_api` (or `api`) and `read_repository`.
- **Private Package**: `"private": true` is set in `package.json` to prevent accidental publication to public package registries.
- **Self-Contained Offline Assets**: All styling and diff libraries are bundled directly so that the viewer makes no requests to third-party CDNs.

---

## License

This project is dedicated to the public domain under the [Unlicense](LICENSE) - see the [LICENSE](LICENSE) file for details.
