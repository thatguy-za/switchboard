package main

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// These tests keep the interface inside its design system (docs/design-system.md):
// raw values live only in css/tokens.css, every component is documented in the style
// guide, and screens use the shared builders instead of hand-written styling.

const webDir = "web"

func read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(webDir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// cssFiles are the stylesheets that must obey the token rules; tokens.css itself is exempt.
func cssFiles(t *testing.T) []string {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(webDir, "css", "*.css"))
	var out []string
	for _, f := range files {
		out = append(out, filepath.Base(f))
	}
	sort.Strings(out)
	return out
}

// appFiles are the scripts and pages we wrote (not vendored libraries).
func appFiles() []string {
	return []string{"index.html", "design.html", "ui.js", "app.js", "workspace.js", "rdp.js", "design.js", "sw.js"}
}

type line struct {
	no    int
	text  string
	allow bool
}

var cssComment = regexp.MustCompile(`/\*.*?\*/`)

// cssLines drops comments but remembers which lines carry a "ds-allow" exemption.
func cssLines(src string) []line {
	var out []line
	inComment := false
	for i, raw := range strings.Split(src, "\n") {
		allow := strings.Contains(raw, "ds-allow")
		text := raw
		if inComment {
			if j := strings.Index(text, "*/"); j >= 0 {
				text, inComment = text[j+2:], false
			} else {
				continue
			}
		}
		text = cssComment.ReplaceAllString(text, "")
		if j := strings.Index(text, "/*"); j >= 0 {
			text, inComment = text[:j], true
		}
		out = append(out, line{i + 1, text, allow})
	}
	return out
}

func TestRawValuesLiveOnlyInTokens(t *testing.T) {
	color := regexp.MustCompile(`#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(`)
	length := regexp.MustCompile(`(?:^|[^\w.%-])-?(\d*\.?\d+)(px|rem|em|ms)\b`)
	url := regexp.MustCompile(`url\([^)]*\)`)
	allowed := map[string]bool{"1px": true, "2px": true, "1.5px": true}
	for _, name := range cssFiles(t) {
		if name == "tokens.css" {
			continue
		}
		for _, l := range cssLines(read(t, "css/"+name)) {
			if l.allow {
				continue
			}
			text := url.ReplaceAllString(l.text, "")
			if strings.Contains(text, "@media") {
				for _, m := range regexp.MustCompile(`\d+px`).FindAllString(text, -1) {
					if m != "760px" {
						t.Errorf("css/%s:%d: media queries use the one breakpoint, 760px, not %s", name, l.no, m)
					}
				}
				continue
			}
			if m := color.FindString(text); m != "" {
				t.Errorf("css/%s:%d: raw colour %q: use a token from tokens.css", name, l.no, m)
			}
			for _, m := range length.FindAllStringSubmatch(text, -1) {
				if !allowed[m[1]+m[2]] {
					t.Errorf("css/%s:%d: raw length %s%s: use a token from tokens.css", name, l.no, m[1], m[2])
				}
			}
		}
	}
	// Scripts may not carry colours either: terminal palettes come from the --term-* tokens.
	hex := regexp.MustCompile(`#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b|\brgba?\(|\bhsla?\(`)
	for _, name := range []string{"ui.js", "app.js", "workspace.js", "rdp.js", "design.js", "index.html", "design.html"} {
		for i, ln := range strings.Split(read(t, name), "\n") {
			if strings.Contains(ln, "ds-allow") || strings.Contains(ln, `name="theme-color"`) { // checked against the tokens below
				continue
			}
			// resolveColor builds rgb() strings from canvas pixels; that is the one place that may.
			if name == "ui.js" && strings.Contains(ln, "rgb") {
				continue
			}
			if m := hex.FindString(ln); m != "" {
				t.Errorf("%s:%d: raw colour %q: use a token", name, i+1, m)
			}
		}
	}
}

func TestNoInlineStyles(t *testing.T) {
	attr := regexp.MustCompile(`\bstyle\s*=\s*["'{]`)
	prop := regexp.MustCompile(`\.style\.\w+\s*=|\.style\.setProperty\(|\.style\.cssText`)
	for _, name := range appFiles() {
		for i, ln := range strings.Split(read(t, name), "\n") {
			if strings.Contains(ln, "ds-allow") {
				continue
			}
			if attr.MatchString(ln) || prop.MatchString(ln) {
				t.Errorf("%s:%d: inline style: use a component class or token (or mark a dynamic value with ds-allow and a reason)", name, i+1)
			}
		}
	}
}

func declaredTokens(t *testing.T) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`(--[a-zA-Z0-9-]+)\s*:`).FindAllStringSubmatch(read(t, "css/tokens.css"), -1) {
		out[m[1]] = true
	}
	return out
}

func TestEveryTokenUsedIsDeclared(t *testing.T) {
	declared := declaredTokens(t)
	// Set from script for one element at a time; they have no global value.
	dynamic := map[string]bool{"--swatch": true, "--bar": true, "--radius": true}
	use := regexp.MustCompile(`var\((--[a-zA-Z0-9-]+)`)
	check := func(name, src string) {
		for _, m := range use.FindAllStringSubmatch(src, -1) {
			if !declared[m[1]] && !dynamic[m[1]] {
				t.Errorf("%s: uses %s, which tokens.css does not declare", name, m[1])
			}
		}
	}
	for _, n := range cssFiles(t) {
		check("css/"+n, read(t, "css/"+n))
	}
	for _, n := range appFiles() {
		check(n, read(t, n))
	}
}

// Classes used only as hooks for scripts, not for styling.
var hookClasses = map[string]bool{"clip": true, "files": true, "cliptext": true, "fileinput": true, "filecrumb": true, "filestatus": true, "fwdlist": true}

func TestClassesAreDefined(t *testing.T) {
	defined := map[string]bool{}
	def := regexp.MustCompile(`\.([A-Za-z_][\w-]*)`)
	url := regexp.MustCompile(`url\([^)]*\)`)
	for _, n := range cssFiles(t) {
		for _, l := range cssLines(read(t, "css/"+n)) {
			for _, m := range def.FindAllStringSubmatch(url.ReplaceAllString(l.text, ""), -1) {
				defined[m[1]] = true
			}
		}
	}
	known := func(c string) bool {
		if defined[c] || hookClasses[c] {
			return true
		}
		// "d" in class="row d${depth}" and "dir-" in 'split dir-' + dir are built from a prefix.
		for d := range defined {
			if (strings.HasSuffix(c, "-") || c == "d") && strings.HasPrefix(d, c) {
				return true
			}
		}
		return false
	}
	interp := regexp.MustCompile(`\$\{[^}]*\}`)
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`class="([^"]*)"`),
		regexp.MustCompile(`class='([^']*)'`),
		regexp.MustCompile(`\bel\('[a-z0-9]+',\s*'([^']*)'`),
		regexp.MustCompile(`classList\.(?:add|remove|toggle|contains)\('([^']+)'`),
		regexp.MustCompile(`\bbutton\([^)]*kind:\s*'([^']*)'`),
		regexp.MustCompile(`cls:\s*'([^']*)'`),
	}
	for _, name := range appFiles() {
		for i, ln := range strings.Split(read(t, name), "\n") {
			for _, p := range patterns {
				for _, m := range p.FindAllStringSubmatch(ln, -1) {
					for _, c := range strings.Fields(interp.ReplaceAllString(m[1], " ")) {
						if !known(c) {
							t.Errorf("%s:%d: class %q is not defined in the stylesheets", name, i+1, c)
						}
					}
				}
			}
		}
	}
}

func TestIconsExist(t *testing.T) {
	sprite := read(t, "icons.svg")
	have := map[string]bool{}
	for _, m := range regexp.MustCompile(`id="i-([a-z0-9-]+)"`).FindAllStringSubmatch(sprite, -1) {
		have[m[1]] = true
	}
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`\bicon\('([a-z0-9-]+)'`),
		regexp.MustCompile(`\biconButton\('([a-z0-9-]+)'`),
		regexp.MustCompile(`\bicon:\s*'([a-z0-9-]+)'`),
		regexp.MustCompile(`\[\s*'[^']*',\s*'[A-Z][^']*',\s*'([a-z0-9-]+)'\s*\]`),
		regexp.MustCompile(`\bcon\('([a-z0-9-]+)'`),
		regexp.MustCompile(`\?\s*'([a-z0-9]+(?:-[a-z0-9]+)+)'\s*:`),
	}
	for _, name := range appFiles() {
		for i, ln := range strings.Split(read(t, name), "\n") {
			for _, p := range patterns {
				for _, m := range p.FindAllStringSubmatch(ln, -1) {
					if !have[m[1]] {
						t.Errorf("%s:%d: icon %q is not in icons.svg", name, i+1, m[1])
					}
				}
			}
		}
	}
}

func TestEveryComponentIsInTheStyleGuide(t *testing.T) {
	inCSS := map[string]bool{}
	for _, m := range regexp.MustCompile(`/\*\s*@component\s+([a-z-]+)\s*\*/`).FindAllStringSubmatch(read(t, "css/components.css"), -1) {
		inCSS[m[1]] = true
	}
	inGuide := map[string]bool{}
	for _, m := range regexp.MustCompile(`\{\s*id:\s*'([a-z-]+)',\s*name:\s*'[^']+',\s*description:`).FindAllStringSubmatch(read(t, "design.js"), -1) {
		inGuide[m[1]] = true
	}
	if len(inCSS) < 20 {
		t.Fatalf("expected the component library to define many components, found %d", len(inCSS))
	}
	for c := range inCSS {
		if !inGuide[c] {
			t.Errorf("component %q is in components.css but not shown in the style guide (design.js)", c)
		}
	}
	for c := range inGuide {
		if !inCSS[c] {
			t.Errorf("the style guide shows %q, which components.css does not define with an @component marker", c)
		}
	}
}

/* ---------- contrast ---------- */

func lum(hex string) float64 {
	hex = strings.TrimPrefix(hex, "#")
	ch := func(s string) float64 {
		v, _ := strconv.ParseInt(s, 16, 0)
		f := float64(v) / 255
		if f <= 0.03928 {
			return f / 12.92
		}
		return math.Pow((f+0.055)/1.055, 2.4)
	}
	return 0.2126*ch(hex[0:2]) + 0.7152*ch(hex[2:4]) + 0.0722*ch(hex[4:6])
}

func contrast(a, b string) float64 {
	la, lb := lum(a), lum(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// themeTokens resolves the semantic colour tokens for a theme to hex values.
func themeTokens(t *testing.T, light bool) map[string]string {
	t.Helper()
	src := read(t, "css/tokens.css")
	decl := regexp.MustCompile(`(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);`)
	values := map[string]string{}
	// Base :root blocks first, then the light override block when asked for.
	blocks := regexp.MustCompile(`(?s):root\s*\{(.*?)\n\}`).FindAllStringSubmatch(src, -1)
	lightBlock := regexp.MustCompile(`(?s):root\[data-theme="light"\]\s*\{(.*?)\n\}`).FindStringSubmatch(src)
	for _, b := range blocks {
		for _, m := range decl.FindAllStringSubmatch(b[1], -1) {
			values[m[1]] = strings.TrimSpace(m[2])
		}
	}
	if light && lightBlock != nil {
		for _, m := range decl.FindAllStringSubmatch(lightBlock[1], -1) {
			values[m[1]] = strings.TrimSpace(m[2])
		}
	}
	varRef := regexp.MustCompile(`^var\((--[a-zA-Z0-9-]+)\)$`)
	var resolve func(string, int) string
	resolve = func(v string, depth int) string {
		if m := varRef.FindStringSubmatch(v); m != nil && depth < 8 {
			return resolve(values[m[1]], depth+1)
		}
		return v
	}
	out := map[string]string{}
	for k, v := range values {
		out[k] = resolve(v, 0)
	}
	return out
}

func TestTextContrast(t *testing.T) {
	type pair struct {
		fg, bg string
		min    float64
	}
	pairs := []pair{
		{"--text", "--bg", 7}, {"--text", "--surface-raised", 7}, {"--text", "--surface-side", 7}, {"--text", "--surface-term", 7},
		{"--text-2", "--bg", 4.5}, {"--text-2", "--surface-raised", 4.5}, {"--text-2", "--surface-side", 4.5},
		{"--text-3", "--bg", 4.5}, {"--text-3", "--surface-raised", 4.5}, {"--text-3", "--surface-side", 4.5},
		{"--text-2", "--surface-selected", 4.5}, {"--text-2", "--surface-hover", 4.5},
		{"--text-3", "--surface-selected", 4.5}, {"--text-3", "--surface-hover", 4.5},
		{"--acc-text", "--bg", 4.5}, {"--acc-text", "--surface-raised", 4.5},
		{"--acc-ink", "--acc", 4.5}, {"--acc-ink", "--acc-hover", 4.5}, {"--on-danger", "--danger", 4.5},
		{"--danger", "--bg", 4.5}, {"--danger", "--surface-raised", 4.5},
		{"--warn", "--bg", 4.5}, {"--warn", "--surface-raised", 4.5},
	}
	for _, light := range []bool{false, true} {
		name := map[bool]string{false: "dark", true: "light"}[light]
		tok := themeTokens(t, light)
		for _, p := range pairs {
			fg, bg := tok[p.fg], tok[p.bg]
			if !strings.HasPrefix(fg, "#") || !strings.HasPrefix(bg, "#") {
				t.Errorf("%s: %s or %s did not resolve to a hex colour (%q, %q)", name, p.fg, p.bg, fg, bg)
				continue
			}
			if c := contrast(fg, bg); c < p.min {
				t.Errorf("%s theme: %s on %s has contrast %.2f, needs %.1f", name, p.fg, p.bg, c, p.min)
			}
		}
	}
}

// The browser's own chrome (address bar, installed-app title bar) is coloured by values that cannot
// be CSS variables, so they must match the background token.
func TestBrowserChromeColoursMatchTheTokens(t *testing.T) {
	dark, light := themeTokens(t, false)["--bg"], themeTokens(t, true)["--bg"]
	html := read(t, "index.html")
	for _, want := range []struct{ scheme, hex string }{{"light", light}, {"dark", dark}} {
		re := regexp.MustCompile(`name="theme-color" content="(#[0-9a-fA-F]{6})" media="\(prefers-color-scheme: ` + want.scheme + `\)"`)
		m := re.FindStringSubmatch(html)
		if m == nil || !strings.EqualFold(m[1], want.hex) {
			t.Errorf("index.html theme-color for %s should be %s (the --bg token), got %v", want.scheme, want.hex, m)
		}
	}
	brand := themeTokens(t, false)["--brand-ink"]
	manifest := read(t, "manifest.webmanifest")
	for _, key := range []string{"background_color", "theme_color"} {
		m := regexp.MustCompile(`"` + key + `":\s*"(#[0-9a-fA-F]{6})"`).FindStringSubmatch(manifest)
		if m == nil || !strings.EqualFold(m[1], brand) {
			t.Errorf("manifest %s should be %s (the --brand-ink token), got %v", key, brand, m)
		}
	}
}
