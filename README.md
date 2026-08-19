# City Map Coaster Studio

A browser tool for designing street-map coasters and exporting them as
millimetre-accurate SVG for a laser — xTool Creative Space, LightBurn, LaserGRBL,
Glowforge, or anything else that reads SVG.

Type in a city or an address, tune what gets engraved, and download a file that
is already the right physical size.

![The studio with the demo city loaded](docs/screenshot.png)

## Running it

No build step, no bundler, no install:

```bash
node server.js          # → http://localhost:5173
```

Any static server works (`python3 -m http.server`, `npx serve`, …), but it does
have to be a server — opening `index.html` from the filesystem breaks ES modules
and `fetch`.

Everything runs in the browser. Nothing is uploaded anywhere, and your design is
kept in `localStorage` so it survives a reload.

## What it does

**Location.** Search any city, address or landmark, or paste `39.9943, -76.7298`
straight into the box. Drag the preview to pan and scroll to zoom; map data is
refetched only when you leave the area already downloaded.

**Layers.** Motorways, primary/secondary/minor roads, residential streets,
service roads, footpaths, railways, rivers, streams and canals, lakes and bays,
parks and woodland, and buildings — each one toggled independently with its own
thickness in millimetres. Area layers (water, parks, buildings) draw either as
solid shapes or as outlines.

**Frame.** Square, rounded-square or round coasters at any size, with a border of
adjustable thickness and corner radius. **Map only** puts the frame around the
map with the caption below it; **Map + caption** runs it around the coaster
perimeter with the place name inside, as on the reference coaster. There is an
optional cut line on its own layer.

**Caption.** Any number of lines under the map, each with its own font, weight,
italic, size, letter-spacing, line-spacing, capitalisation, alignment and
sideways nudge. Drag the caption in the preview to move the whole block, or nudge
it with the sliders. Searching a place rewrites the place name and coordinates
for you, and panning keeps the coordinates in step until you edit the text
yourself.

**Pin.** Seven marker shapes — disc, oval, pill, heart, teardrop map pin, ring
and plain dot — centred on the map or dropped anywhere by clicking. Put `Home`,
`Family` or anything else inside, knocked out of the shape so the letters stay
unengraved. The oval and pill stretch to fit the word; the round shapes grow as a
whole, so "Pin size" is a floor rather than a hard limit and a long word never
spills over the edge.

**Undo.** Undo and redo sit at the top of the panel and answer to Ctrl/Cmd+Z and
Ctrl/Cmd+Shift+Z. History works in gestures, so dragging a slider is one step
rather than forty. **Reset to defaults** is undoable too.

**Labels.** Optional street, park and water names, rotated to follow the road
they name, with collision avoidance and a cap on how many appear.

## Getting a good burn

The exported file is built for laser software specifically, not just "an SVG that
happens to look right":

- **Real millimetres.** The root element carries `width="100mm" height="100mm"`
  alongside a matching `viewBox`, so the artwork imports at 1:1 with no scaling
  step to get wrong.
- **No clip paths.** Geometry is clipped mathematically to the map window before
  it is written out. Laser software either ignores `clipPath` or engraves what it
  hides; here there is nothing hidden to get wrong.
- **No live text.** Every glyph — caption, pin and labels alike — is converted to
  outlines. Your machine does not need the font, and it cannot substitute one.
- **No transforms.** Rotations are baked into the coordinates, so importers that
  drop `transform` attributes cannot stack every rotated label at the origin.
- **Genuine clear space.** The pin and each label do not merely sit *on top of*
  the streets — the streets underneath are actually removed, so knocked-out
  letters read as bare slate instead of filling in with whatever ran beneath.
- **Named layers.** Each layer is its own `<g>` with an id and an Inkscape layer
  label, which LightBurn and Inkscape both pick up.
- **Optional colour coding.** "Colour per layer" gives every layer a distinct
  stroke colour so xTool and LightBurn can assign separate power and speed per
  layer. "One colour" keeps the whole thing as a single operation.

### Importing into xTool Creative Space

1. Add → Import Image/File, pick the SVG. It arrives at its true size; do not
   scale it.
2. Set the processing type to **Engrave** (fill/raster) for the map. Slate takes
   a light touch — start around 60–70% power at high speed and test on an
   offcut.
3. If you exported with **Colour per layer**, XCS splits the file into one object
   per colour; select each and set its own parameters. Solid buildings and water
   usually want more power than hairline streets.
4. If you enabled the cut line, move that layer to **Cut** (or **Score**) — it is
   the only red `#ff0000` path in the file.

### Importing into LightBurn

The layer groups come through as named layers. Assign each a colour layer, set
Fill for the solid shapes and Line for the strokes, and the whole coaster runs as
one job.

### Sizing notes

Slate coasters sold as "4 inch" are usually 100 mm; the presets cover 95 mm,
100 mm and a true 101.6 mm. Leave the default 5 mm edge margin — slate coasters
have irregular chipped edges, and artwork that runs closer than about 4 mm tends
to fall off the usable face.

Streets thinner than about 0.15 mm tend to disappear on slate. If a design comes
out too faint, raise **Overall line weight** rather than editing every layer.

## Working offline

**Use demo city** loads a synthetic town bundled with the app, so you can explore
every control — and check the export pipeline — with no network at all. It is
generated data, not a real place; regenerate it with `npm run fixture`.

## Tests

```bash
npm test              # geometry, typography, pipeline, plus a browser pass
npm test -- --no-browser
```

The suite checks the projection round-trips, that clipping and knockout
subtraction remove exactly the right area, that multipolygon lakes keep their
islands, that no geometry escapes the map window, that nothing survives under the
pin, and that every marker shape's knockout really covers the shape drawn on top
of it. The browser pass boots the app, cycles through all seven marker shapes,
drags the caption, undoes and redoes, resets, searches a stubbed place and checks
the caption filled itself, then exports an SVG and confirms it restores after a
reload.

`node tools/render-fixture.mjs out.svg --preset labels` renders the demo city
headlessly, which is handy when changing the geometry pipeline.

## How it fits together

| File | Job |
| --- | --- |
| `src/geo.js` | Web-Mercator projection, lon/lat ↔ millimetres |
| `src/clip.js` | Convex clipping, and the subtraction that makes clear space |
| `src/simplify.js` | Douglas–Peucker thinning in millimetre space |
| `src/overpass.js` | Query assembly and mirror fallback |
| `src/geocode.js` | Nominatim with a Photon fallback |
| `src/osm.js` | Overpass JSON → features, including multipolygon stitching |
| `src/layers.js` | Tag → layer taxonomy, defaults, paint order |
| `src/layout.js` | Where the map, border and caption sit on the coaster |
| `src/prepare.js` | Project, thin, clip and group geometry per layer |
| `src/labels.js` | Label selection, placement and collision avoidance |
| `src/pinshapes.js` | Marker outlines and their convex decompositions |
| `src/paths.js` | Shared rounded-rect and ellipse path builders |
| `src/knockouts.js` | The shapes punched out for the pin and labels |
| `src/typography.js` | Font loading and text-to-outline conversion |
| `src/render.js` | Builds the SVG for both preview and export |
| `src/state.js` | The design object, store and persistence |
| `src/ui.js`, `src/controls.js` | The control panel |
| `src/main.js` | Wiring, data fetching, pan/zoom/click |

## Credits and licensing

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, available under the Open Database Licence (ODbL). Anything you
  publish or sell that is derived from it needs to carry that attribution — the
  exported SVG includes it in its `<desc>`.
- Geocoding by [Nominatim](https://nominatim.org) and
  [Photon](https://photon.komoot.io). Both are free community services; the
  usage policies ask for reasonable request rates, which is why search here is
  manual rather than type-ahead.
- [opentype.js](https://opentype.js.org) (MIT) does the text-to-outline work.
- Bundled fonts are SIL Open Font License 1.1 — see `assets/fonts/README.md`.
- This app's own code is MIT licensed.
