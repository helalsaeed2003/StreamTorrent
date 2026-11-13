#!/usr/bin/env node
/**
 * Prints the CHANGELOG section for one version, for the release notes.
 *
 *   node bin/changelog-for.js 0.98.3
 *   node bin/changelog-for.js v0.98.3 > notes.md
 *
 * It takes everything under the "## [0.98.3] - date" heading up to the next
 * "## " heading, with the link definitions at the bottom left out. If there
 * is no section for that version it says so and exits 1, so a release is not
 * published with empty notes by accident.
 */

const fs = require('fs')
const path = require('path')

const wanted = String(process.argv[2] || '').replace(/^v/, '').trim()
if (!wanted) {
  console.error('Usage: node bin/changelog-for.js <version>')
  process.exit(1)
}

const file = path.join(__dirname, '..', 'CHANGELOG.md')
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

// "## [0.98.3] - 2026-11-13" or "## 0.98.3"
const heading = new RegExp('^##\\s+\\[?' +
  wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]?(\\s|$)')

const start = lines.findIndex(line => heading.test(line))
if (start < 0) {
  console.error('CHANGELOG.md has no section for ' + wanted)
  process.exit(1)
}

const rest = lines.slice(start + 1)
const end = rest.findIndex(line => /^##\s/.test(line))
const body = (end < 0 ? rest : rest.slice(0, end))
  .filter(line => !/^\[[^\]]+\]:\s/.test(line))
  .join('\n')
  .trim()

if (!body) {
  console.error('The section for ' + wanted + ' in CHANGELOG.md is empty')
  process.exit(1)
}

console.log(body)
