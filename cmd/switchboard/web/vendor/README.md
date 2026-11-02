# Vendored libraries

Third-party files served as they came from upstream. `SHA256SUMS` records each file's
checksum and `go test` fails if one changes, so an edit here has to be deliberate:
update the file, rerun `shasum -a 256 <files> > SHA256SUMS`, and update this table.

| File | Project | Version | Checked against upstream |
|---|---|---|---|
| `xterm.css` | [xterm.js](https://github.com/xtermjs/xterm.js) | 5.5.0 (`@xterm/xterm`) | identical to the npm package |
| `xterm.js` | xterm.js | not verified | does not match the 5.5.0 or 5.3.0 npm build |
| `addon-fit.js` | xterm.js fit addon | not verified | does not match 0.10.0 or 0.8.0 |
| `guacamole-common.js` | [Apache Guacamole](https://guacamole.apache.org/) client | API 1.5.0 | does not match the npm `guacamole-common-js` 1.5.0 build |
| `guacamole-common.LICENSE` | Apache License 2.0 | | |

The three "not verified" files are the builds we have shipped from the start; replacing them
with a known npm release (and recording its version here) is the way to close that gap.
