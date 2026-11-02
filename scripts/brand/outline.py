"""Writes logo-light.svg and logo-dark.svg with the text turned into outlines (DESIGN.md 2.2),
so the files do not depend on JetBrains Mono being installed. Run through scripts/brand/build.sh."""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

font = TTFont(sys.argv[1])
font = instantiateVariableFont(font, {"wght": 700})
gs, cmap = font.getGlyphSet(), font.getBestCmap()
upm = font["head"].unitsPerEm
size, spacing = 44, -1.76
scale = size / upm
parts = []
x = 0.0
for ch in "webterm":
    name = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[name].draw(pen)
    parts.append(f'<path transform="translate({x:.2f} 44) scale({scale:.5f} -{scale:.5f})" d="{pen.getCommands()}"/>')
    x += gs[name].width * scale + spacing
body = "\n  ".join(parts)
for theme, fill in (("light", "#14181F"), ("dark", "#F3F1EA")):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 212 56" role="img" aria-label="webterm">
  <title>webterm</title>
  <g fill="{fill}">
  {body}
  </g>
  <rect x="180" y="11.4" width="22" height="37.8" rx="3" fill="#2FB383"/>
</svg>
'''
    open(f"{sys.argv[2]}/logo-{theme}.svg", "w").write(svg)
print("advance end", round(x, 2))
