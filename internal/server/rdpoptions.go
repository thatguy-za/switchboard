package server

import "encoding/json"

// rdpOptions are a host's display and device settings. A host that has never
// saved any gets the defaults: the desktop follows the window and everything
// is on except the wallpaper.
type rdpOptions struct {
	Width     int    `json:"width"` // 0 with Height 0: follow the window
	Height    int    `json:"height"`
	Depth     int    `json:"depth"`  // bits per pixel: 16, 24 or 32
	Layout    string `json:"layout"` // a guacd keyboard layout
	Wallpaper bool   `json:"wallpaper"`
	Smoothing bool   `json:"smoothing"`
	Audio     bool   `json:"audio"`
	Clipboard bool   `json:"clipboard"`
	Files     bool   `json:"files"`
}

func defaultRDPOptions() rdpOptions {
	return rdpOptions{Depth: 32, Layout: "en-us-qwerty", Smoothing: true, Audio: true, Clipboard: true, Files: true}
}

// parseRDPOptions reads stored options; anything missing keeps its default.
func parseRDPOptions(raw string) rdpOptions {
	o := defaultRDPOptions()
	if raw != "" {
		json.Unmarshal([]byte(raw), &o)
	}
	if !validRDPOptions(&o) {
		return defaultRDPOptions()
	}
	return o
}

var rdpLayouts = map[string]bool{
	"en-us-qwerty": true, "en-gb-qwerty": true, "de-de-qwertz": true, "de-ch-qwertz": true,
	"fr-fr-azerty": true, "fr-be-azerty": true, "fr-ca-qwerty": true, "fr-ch-qwertz": true,
	"es-es-qwerty": true, "es-latam-qwerty": true, "it-it-qwerty": true, "pt-br-qwerty": true,
	"pt-pt-qwerty": true, "sv-se-qwerty": true, "da-dk-qwerty": true, "no-no-qwerty": true,
	"pl-pl-qwerty": true, "tr-tr-qwerty": true, "hu-hu-qwertz": true, "ja-jp-qwerty": true,
}

func validRDPOptions(o *rdpOptions) bool {
	fit := o.Width == 0 && o.Height == 0
	fixed := o.Width >= minDisplayW && o.Width <= maxDisplayW && o.Height >= minDisplayH && o.Height <= maxDisplayH
	return (fit || fixed) && (o.Depth == 16 || o.Depth == 24 || o.Depth == 32) && rdpLayouts[o.Layout]
}

func (o rdpOptions) fixedSize() bool { return o.Width > 0 && o.Height > 0 }

func (o rdpOptions) encode() string {
	b, _ := json.Marshal(o)
	return string(b)
}
