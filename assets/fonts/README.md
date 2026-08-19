# Bundled fonts

These are Latin subsets of Google Fonts families, taken from the matching
[Fontsource](https://fontsource.org) packages and committed here so the app runs
with no network and no CDN.

Every family below is licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org), which permits bundling
and redistribution — including in the SVG files this app exports, where the
glyphs are converted to outlines rather than embedded as font data.

| Family | Weights | Designer(s) |
| --- | --- | --- |
| Playfair Display | 400, 700, 400 italic | Claus Eggers Sørensen |
| Cormorant Garamond | 400, 700, 400 italic | Christian Thalmann / Catharsis Fonts |
| EB Garamond | 400, 700, 400 italic | Georg Duffner, Octavio Pardo |
| Libre Baskerville | 400, 700, 400 italic | Impallari Type |
| Marcellus | 400 | Astigmatic |
| Cinzel | 400, 700 | Natanael Gama |
| Montserrat | 400, 700, 400 italic | Julieta Ulanovsky and contributors |
| Josefin Sans | 400, 700, 400 italic | Santiago Orozco |

To add another family, drop `<id>-<weight>-<style>.woff` in this folder and add
an entry to `FONTS` in `src/typography.js`. WOFF and TTF/OTF both work; WOFF2
does not, because opentype.js cannot decompress it.
