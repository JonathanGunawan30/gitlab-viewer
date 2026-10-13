#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';

import { resolveToken, resolveHost, saveConfig, getConfig } from '../src/config.js';
import { parseGitLabInput } from '../src/parser.js';
import { fetchMergeRequestData } from '../src/gitlab.js';
import { generateViewerHtml, calculateStats } from '../src/generator.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const program = new Command();

program
  .name('mr-view')
  .description('Ultra-lightweight private GitLab MR diff viewer CLI with zero server overhead')
  .version(pkg.version);

// ==========================================
// Config Subcommands
// ==========================================
const configCmd = program.command('config').description('Manage CLI configuration (token, default host)');

configCmd
  .command('set-token <token>')
  .description('Save your GitLab Personal Access Token (PAT)')
  .action((token) => {
    saveConfig({ token: token.trim() });
    console.log(chalk.green('✔ GitLab Personal Access Token saved successfully!'));
  });

configCmd
  .command('set-host <host>')
  .description('Set default GitLab host (e.g. https://gitlab.mycompany.com)')
  .action((host) => {
    const cleanHost = host.trim().replace(/\/+$/, '');
    saveConfig({ host: cleanHost });
    console.log(chalk.green(`✔ Default GitLab Host saved: ${chalk.bold(cleanHost)}`));
  });

configCmd
  .command('show')
  .description('View current configuration')
  .action(() => {
    const conf = getConfig();
    const token = conf.token || '';
    const masked = token.length > 8 
      ? token.slice(0, 4) + '****' + token.slice(-4) 
      : (token ? '****' : '(not set)');

    console.log(chalk.bold('\nGitLab Viewer Configuration:'));
    console.log(`  Token:        ${chalk.cyan(masked)}`);
    console.log(`  Default Host: ${chalk.cyan(conf.host || 'https://gitlab.com (default)')}\n`);
  });

// ==========================================
// Main View Action
// ==========================================
program
  .argument('[url]', 'GitLab Merge Request URL or ref (e.g. https://gitlab.com/group/repo/-/merge_requests/42)')
  .option('-t, --token <token>', 'GitLab Personal Access Token (overrides saved config)')
  .option('-H, --host <host>', 'GitLab host (defaults to URL origin or saved config)')
  .option('-o, --out <path>', 'Output custom file path instead of temp preview file')
  .option('--no-open', 'Generate HTML file without automatically opening browser')
  .action(async (inputUrl, options) => {
    try {
      // 1. Check or prompt for URL if omitted
      let targetUrl = inputUrl;
      if (!targetUrl) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        targetUrl = await rl.question(chalk.yellow('? Paste GitLab Merge Request URL: '));
        rl.close();
        if (!targetUrl || !targetUrl.trim()) {
          console.log(chalk.red('✖ URL is required. Exiting.'));
          process.exit(1);
        }
      }

      // 2. Resolve Host & Parse URL
      const defaultHost = resolveHost(options.host);
      const parsed = parseGitLabInput(targetUrl, defaultHost);

      // 3. Resolve Token
      let token = resolveToken(options.token);
      if (!token) {
        console.log(chalk.yellow('\nGitLab Personal Access Token not found.'));
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        token = await rl.question(chalk.cyan('? Enter your GitLab Personal Access Token (PAT): '));
        rl.close();

        if (!token || !token.trim()) {
          console.log(chalk.red('✖ Token is required to access private repositories. Exiting.'));
          process.exit(1);
        }
        token = token.trim();
        saveConfig({ token });
        console.log(chalk.green('✔ Token saved to config for future use.\n'));
      }

      // 4. Fetch MR Data with Loading Spinner
      const spinner = ora({
        text: `Fetching MR !${parsed.mrIid} from ${parsed.host} (${parsed.projectPath})...`,
        color: 'cyan'
      }).start();

      const mrData = await fetchMergeRequestData({
        host: parsed.host,
        projectEncoded: parsed.projectEncoded,
        mrIid: parsed.mrIid,
        token,
        onProgress: (msg) => {
          spinner.text = msg;
        }
      });

      spinner.text = 'Compiling diffs and generating high-contrast viewer...';

      // 5. Generate Standalone HTML Viewer
      const html = generateViewerHtml(mrData);
      const stats = calculateStats(mrData.rawDiff, mrData.changes);

      // 6. Write File (Auto-overwrite single temp file to avoid junk accumulation)
      const outputPath = options.out 
        ? path.resolve(process.cwd(), options.out)
        : path.join(os.tmpdir(), 'gitlab-viewer-preview.html');

      fs.writeFileSync(outputPath, html, 'utf8');

      spinner.succeed(
        chalk.green(`MR !${parsed.mrIid} loaded successfully: `) + 
        chalk.bold(`"${mrData.mr.title}"`)
      );

      if (mrData.hasOverflow) {
        console.log(chalk.yellow('   ⚠ Warning: Some changes or files were truncated or collapsed by GitLab limits.'));
      }
      if (mrData.hasPartialDiscussions) {
        console.log(chalk.yellow('   ⚠ Warning: Could not fetch all discussion comments (some comments may be missing).'));
      }

      // Print quick summary stats
      console.log(
        `   Branch:   ${chalk.cyan(mrData.mr.source_branch)} → ${chalk.cyan(mrData.mr.target_branch)}\n` +
        `   Changes:  ${chalk.bold(stats.totalFiles)} files (${chalk.green('+' + stats.totalAdditions)} / ${chalk.red('-' + stats.totalDeletions)})\n` +
        `   Preview:  ${chalk.dim(outputPath)}`
      );

      // 7. Auto-open in Browser
      if (options.open !== false) {
        await open(outputPath);
        console.log(chalk.green('✔ Opened in default browser.\n'));
      }

      // 8. Immediate Exit (Zero lingering process, Zero RAM usage)
      process.exit(0);

    } catch (err) {
      console.error(chalk.red(`\n✖ Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program.parse(process.argv);
