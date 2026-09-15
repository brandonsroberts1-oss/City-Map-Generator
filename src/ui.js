// The control panel. Every section is built once and then kept in sync with the
// store, so editing a caption never rebuilds the field you are typing into.

import {
  el, slider, numberInput, textInput, toggle, select, segmented, button, section, row,
} from './controls.js';
import { LAYERS, LAYER_GROUPS } from './layers.js';
import { FONTS } from './typography.js';
import { PREVIEW_THEMES } from './render.js';
import { COASTER_PRESETS, captionLine } from './state.js';
import { PIN_STYLES, TEXT_STYLES } from './pinshapes.js';

const FONT_OPTIONS = FONTS.map((f) => ({ value: f.id, label: f.name, fontFamily: `'${f.name}', serif` }));
const CASE_OPTIONS = [
  { value: 'none', label: 'As typed' },
  { value: 'upper', label: 'UPPERCASE' },
  { value: 'title', label: 'Title Case' },
  { value: 'lower', label: 'lowercase' },
];
const WEIGHT_OPTIONS = [
  { value: 400, label: 'Regular' },
  { value: 700, label: 'Bold' },
];

function formatSpan(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km` : `${Math.round(metres)} m`;
}

/**
 * @param {object} opts
 * @param {object} opts.store   the design store
 * @param {object} opts.actions side effects the panel can trigger
 */
export function buildPanel({ store, actions }) {
  const panel = el('div', { class: 'panel' });
  const bindings = [];

  /** Registers a control so external state changes can push values back into it. */
  const bind = (node, read) => {
    if (node && typeof node.sync === 'function') bindings.push({ node, read });
    return node;
  };
  const st = () => store.get();
  const update = (mutator, meta) => store.set(mutator, meta);

  // ------------------------------------------------------------- location
  const locationSection = section('Location', { open: true, id: 'section-location' });
  const searchField = textInput({
    label: 'City, address or coordinates',
    value: st().location.query,
    placeholder: 'e.g. York, Pennsylvania',
    onInput: (v) => update((s) => { s.location.query = v; }, { silent: true }),
    onEnter: (v) => actions.search(v),
  });
  const resultsList = el('div', { class: 'results', hidden: true });
  const searchStatus = el('p', { class: 'field-hint search-status' });

  locationSection.body.append(
    searchField,
    row([
      button({ label: 'Search', variant: 'primary', onClick: () => actions.search(st().location.query) }),
      button({ label: 'Use demo city', onClick: () => actions.loadDemo() }),
    ]),
    searchStatus,
    resultsList,
    row([
      bind(numberInput({
        label: 'Latitude', value: st().location.lat, step: 0.0001, min: -85, max: 85,
        onInput: (v) => update((s) => { s.location.lat = v; }, { refetch: true }),
      }), (s) => s.location.lat),
      bind(numberInput({
        label: 'Longitude', value: st().location.lon, step: 0.0001, min: -180, max: 180,
        onInput: (v) => update((s) => { s.location.lon = v; }, { refetch: true }),
      }), (s) => s.location.lon),
    ], 'row row-2'),
    bind(slider({
      label: 'Area covered',
      min: Math.log10(200), max: Math.log10(60000), step: 0.005,
      value: Math.log10(st().view.spanMetres),
      hint: 'Ground distance across the short side of the map window.',
      format: (v) => formatSpan(10 ** v),
      onInput: (v) => update((s) => { s.view.spanMetres = Math.round(10 ** v); }, { refetch: true }),
    }), (s) => Math.log10(s.view.spanMetres)),
    el('p', {
      class: 'field-hint',
      text: 'Drag the preview to pan, scroll to zoom. Map data © OpenStreetMap contributors.',
    })
  );

  function renderResults(results, { error = null, loading = false } = {}) {
    resultsList.replaceChildren();
    searchStatus.textContent = loading ? 'Searching…' : error || '';
    searchStatus.classList.toggle('is-error', Boolean(error));
    if (!results || !results.length) {
      resultsList.hidden = true;
      return;
    }
    resultsList.hidden = false;
    for (const result of results) {
      resultsList.append(
        el('button', {
          type: 'button', class: 'result', onclick: () => { actions.pickResult(result); resultsList.hidden = true; },
        }, [
          el('span', { class: 'result-primary', text: result.primary || result.display }),
          el('span', { class: 'result-secondary', text: result.secondary || result.display }),
        ])
      );
    }
  }

  // -------------------------------------------------------------- coaster
  const coasterSection = section('Coaster & frame', { id: 'section-coaster' });
  const cornerField = bind(slider({
    label: 'Coaster corner radius', min: 0, max: 30, step: 0.5, value: st().coaster.cornerRadius, unit: ' mm',
    onInput: (v) => update((s) => { s.coaster.cornerRadius = v; }),
  }), (s) => s.coaster.cornerRadius);

  const sizeFields = row([
    bind(numberInput({
      label: 'Width', value: st().coaster.width, min: 20, max: 600, step: 0.1, unit: 'mm',
      onInput: (v) => update((s) => { s.coaster.width = v; s.coaster.preset = 'custom'; }),
    }), (s) => s.coaster.width),
    bind(numberInput({
      label: 'Height', value: st().coaster.height, min: 20, max: 600, step: 0.1, unit: 'mm',
      onInput: (v) => update((s) => { s.coaster.height = v; s.coaster.preset = 'custom'; }),
    }), (s) => s.coaster.height),
  ], 'row row-2');

  coasterSection.body.append(
    bind(select({
      label: 'Size preset',
      options: [...COASTER_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom' }],
      value: st().coaster.preset,
      onChange: (id) => update((s) => {
        const preset = COASTER_PRESETS.find((p) => p.id === id);
        s.coaster.preset = id;
        if (preset) {
          s.coaster.width = preset.width;
          s.coaster.height = preset.height;
          s.coaster.shape = preset.shape;
        }
      }),
    }), (s) => s.coaster.preset),
    sizeFields,
    bind(segmented({
      label: 'Shape',
      options: [
        { value: 'rounded', label: 'Rounded' },
        { value: 'square', label: 'Square' },
        { value: 'circle', label: 'Circle' },
      ],
      value: st().coaster.shape,
      onChange: (v) => update((s) => {
        s.coaster.shape = v;
        if (v === 'square') s.coaster.cornerRadius = 0;
        else if (v === 'rounded' && s.coaster.cornerRadius === 0) s.coaster.cornerRadius = 4;
      }),
    }), (s) => s.coaster.shape),
    cornerField,
    bind(slider({
      label: 'Edge margin', min: 0, max: 20, step: 0.5, value: st().coaster.margin, unit: ' mm',
      hint: 'Blank slate between the coaster edge and anything engraved.',
      onInput: (v) => update((s) => { s.coaster.margin = v; }),
    }), (s) => s.coaster.margin),
    el('hr', { class: 'divider' }),
    bind(toggle({
      label: 'Draw a border', value: st().border.enabled,
      onChange: (v) => update((s) => { s.border.enabled = v; }),
    }), (s) => s.border.enabled),
    bind(segmented({
      label: 'Border encloses',
      options: [
        { value: 'map', label: 'Map only', title: 'The frame sits around the map, with the caption below it' },
        { value: 'coaster', label: 'Map + caption', title: 'The frame runs around the whole face, enclosing the caption too' },
      ],
      value: st().border.scope,
      hint: 'Map + caption puts the frame around the coaster perimeter, with the place name inside it.',
      onChange: (v) => update((s) => { s.border.scope = v; }),
    }), (s) => s.border.scope),
    bind(slider({
      label: 'Border thickness', min: 0.1, max: 6, step: 0.05, value: st().border.thickness, unit: ' mm',
      onInput: (v) => update((s) => { s.border.thickness = v; }),
    }), (s) => s.border.thickness),
    bind(slider({
      label: 'Border corner radius', min: 0, max: 30, step: 0.5, value: st().mapArea.cornerRadius, unit: ' mm',
      onInput: (v) => update((s) => { s.mapArea.cornerRadius = v; s.border.radius = v; }),
    }), (s) => s.mapArea.cornerRadius),
    bind(slider({
      label: 'Gap inside border', min: 0, max: 8, step: 0.1, value: st().border.padding, unit: ' mm',
      onInput: (v) => update((s) => { s.border.padding = v; }),
    }), (s) => s.border.padding),
    el('hr', { class: 'divider' }),
    bind(segmented({
      label: 'Map window',
      options: [
        { value: 'fill', label: 'Fill the space' },
        { value: 'square', label: 'Keep it square' },
      ],
      value: st().mapArea.aspect,
      onChange: (v) => update((s) => { s.mapArea.aspect = v; }),
    }), (s) => s.mapArea.aspect),
    bind(toggle({
      label: 'Add a cut line around the coaster',
      value: st().coaster.cutLine,
      hint: 'Exports the outline on its own layer for cutting rather than engraving.',
      onChange: (v) => update((s) => { s.coaster.cutLine = v; }),
    }), (s) => s.coaster.cutLine)
  );

  // --------------------------------------------------------------- layers
  const layersSection = section('Map layers & line weights', { open: true, id: 'section-layers' });
  for (const groupName of LAYER_GROUPS) {
    const groupLayers = LAYERS.filter((l) => l.group === groupName).sort((a, b) => b.order - a.order);
    if (!groupLayers.length) continue;
    layersSection.body.append(el('h4', { class: 'group-heading', text: groupName }));
    for (const layer of groupLayers) {
      const weight = bind(slider({
        label: 'Thickness', min: 0.04, max: 3, step: 0.01, value: st().layers[layer.id].weight, unit: ' mm',
        onInput: (v) => update((s) => { s.layers[layer.id].weight = v; }),
      }), (s) => s.layers[layer.id].weight);

      const controls = el('div', { class: 'layer-controls' }, [weight]);
      if (layer.kind === 'area') {
        controls.prepend(bind(segmented({
          label: 'Draw as',
          options: [
            { value: 'fill', label: 'Solid' },
            { value: 'outline', label: 'Outline' },
          ],
          value: st().layers[layer.id].mode,
          onChange: (v) => update((s) => { s.layers[layer.id].mode = v; }, { refetch: false }),
        }), (s) => s.layers[layer.id].mode));
      }

      const enabled = bind(toggle({
        label: layer.label,
        value: st().layers[layer.id].enabled,
        onChange: (v) => {
          controls.hidden = !v;
          update((s) => { s.layers[layer.id].enabled = v; }, { refetch: true });
        },
      }), (s) => s.layers[layer.id].enabled);
      controls.hidden = !st().layers[layer.id].enabled;
      enabled.syncExtra = (s) => { controls.hidden = !s.layers[layer.id].enabled; };
      bindings.push({ node: { sync: () => enabled.syncExtra(st()) }, read: () => null });

      layersSection.body.append(el('div', { class: 'layer' }, [enabled, controls]));
    }
  }
  layersSection.body.append(
    el('hr', { class: 'divider' }),
    bind(slider({
      label: 'Overall line weight', min: 0.3, max: 3, step: 0.05, value: st().detail.strokeScale,
      format: (v) => `${v.toFixed(2)}×`,
      hint: 'Scales every stroke at once — useful when a design engraves too faint.',
      onInput: (v) => update((s) => { s.detail.strokeScale = v; }),
    }), (s) => s.detail.strokeScale),
    bind(segmented({
      label: 'Line ends',
      options: [
        { value: 'round', label: 'Round' },
        { value: 'butt', label: 'Flat' },
        { value: 'square', label: 'Square' },
      ],
      value: st().detail.lineCap,
      onChange: (v) => update((s) => { s.detail.lineCap = v; }),
    }), (s) => s.detail.lineCap),
    bind(slider({
      label: 'Smallest building kept', min: 0, max: 3, step: 0.02, value: st().detail.minBuildingMm2,
      format: (v) => (v <= 0 ? 'keep everything' : `${v.toFixed(2)} mm²`),
      hint: 'Drops specks the laser cannot resolve and the file does not need.',
      onInput: (v) => update((s) => { s.detail.minBuildingMm2 = v; }),
    }), (s) => s.detail.minBuildingMm2),
    bind(slider({
      label: 'Detail smoothing', min: 0, max: 0.3, step: 0.005, value: st().detail.simplifyMm,
      format: (v) => (v <= 0 ? 'off (largest file)' : `${v.toFixed(3)} mm`),
      hint: 'Removes points that move a line by less than this. Smaller files, same look.',
      onInput: (v) => update((s) => { s.detail.simplifyMm = v; }),
    }), (s) => s.detail.simplifyMm)
  );

  // --------------------------------------------------------------- labels
  const labelsSection = section('Street & place labels', { id: 'section-labels' });
  const labelBody = el('div', { class: 'sub-body' });
  labelsSection.body.append(
    bind(toggle({
      label: 'Show labels',
      value: st().labels.enabled,
      onChange: (v) => {
        labelBody.hidden = !v;
        update((s) => { s.labels.enabled = v; });
      },
    }), (s) => s.labels.enabled),
    labelBody
  );
  labelBody.hidden = !st().labels.enabled;
  bindings.push({ node: { sync: () => { labelBody.hidden = !st().labels.enabled; } }, read: () => null });

  labelBody.append(
    el('div', { class: 'checks' }, [
      bind(toggle({ label: 'Streets', value: st().labels.streets, onChange: (v) => update((s) => { s.labels.streets = v; }) }), (s) => s.labels.streets),
      bind(toggle({ label: 'Water', value: st().labels.water, onChange: (v) => update((s) => { s.labels.water = v; }) }), (s) => s.labels.water),
      bind(toggle({ label: 'Parks', value: st().labels.parks, onChange: (v) => update((s) => { s.labels.parks = v; }) }), (s) => s.labels.parks),
    ]),
    bind(select({
      label: 'Label font', options: FONT_OPTIONS, value: st().labels.font, styleOptions: true,
      onChange: (v) => update((s) => { s.labels.font = v; }, { fonts: true }),
    }), (s) => s.labels.font),
    row([
      bind(segmented({ label: 'Weight', options: WEIGHT_OPTIONS, value: st().labels.weight, onChange: (v) => update((s) => { s.labels.weight = Number(v); }, { fonts: true }) }), (s) => s.labels.weight),
      bind(select({ label: 'Capitalisation', options: CASE_OPTIONS, value: st().labels.textCase, onChange: (v) => update((s) => { s.labels.textCase = v; }) }), (s) => s.labels.textCase),
    ], 'row row-2'),
    bind(slider({ label: 'Label size', min: 0.8, max: 6, step: 0.05, value: st().labels.size, unit: ' mm', onInput: (v) => update((s) => { s.labels.size = v; }) }), (s) => s.labels.size),
    bind(slider({ label: 'Letter spacing', min: -0.1, max: 0.6, step: 0.01, value: st().labels.tracking, unit: ' mm', onInput: (v) => update((s) => { s.labels.tracking = v; }) }), (s) => s.labels.tracking),
    bind(slider({ label: 'Maximum labels', min: 1, max: 80, step: 1, value: st().labels.maxLabels, onInput: (v) => update((s) => { s.labels.maxLabels = v; }) }), (s) => s.labels.maxLabels),
    bind(slider({
      label: 'Only label features longer than', min: 2, max: 60, step: 1, value: st().labels.minFeatureMm, unit: ' mm',
      onInput: (v) => update((s) => { s.labels.minFeatureMm = v; }),
    }), (s) => s.labels.minFeatureMm),
    bind(toggle({
      label: 'Clear the map behind each label',
      value: st().labels.clearSpace,
      hint: 'Removes streets under the text so it stays readable once engraved.',
      onChange: (v) => update((s) => { s.labels.clearSpace = v; }),
    }), (s) => s.labels.clearSpace),
    bind(slider({ label: 'Clear space padding', min: 0, max: 1.5, step: 0.05, value: st().labels.haloMm, unit: ' mm', onInput: (v) => update((s) => { s.labels.haloMm = v; }) }), (s) => s.labels.haloMm)
  );

  // ------------------------------------------------------------------ pin
  const pinSection = section('Location pin', { id: 'section-pin' });
  const pinBody = el('div', { class: 'sub-body' });
  const pinWarning = el('div', { class: 'notice', hidden: true }, [
    el('p', { class: 'notice-text', text: 'The pin is sitting outside the map window, so it is not visible.' }),
    button({ label: 'Bring the pin to the map centre', onClick: () => actions.centrePin() }),
  ]);
  const placeButton = button({
    label: 'Click the preview to place',
    onClick: () => actions.togglePlacePin(),
  });
  pinSection.body.append(
    bind(toggle({
      label: 'Show a pin', value: st().pin.enabled,
      onChange: (v) => { pinBody.hidden = !v; actions.setPinEnabled(v); },
    }), (s) => s.pin.enabled),
    pinWarning,
    pinBody
  );
  pinBody.hidden = !st().pin.enabled;
  bindings.push({ node: { sync: () => { pinBody.hidden = !st().pin.enabled; } }, read: () => null });

  const stemField = bind(slider({
    label: 'Point length', min: 0, max: 20, step: 0.5, value: st().pin.stemLength, unit: ' mm',
    onInput: (v) => update((s) => { s.pin.stemLength = v; }),
  }), (s) => s.pin.stemLength);
  const strokeField = bind(slider({
    label: 'Ring thickness', min: 0.1, max: 3, step: 0.05, value: st().pin.strokeWidth, unit: ' mm',
    onInput: (v) => update((s) => { s.pin.strokeWidth = v; }),
  }), (s) => s.pin.strokeWidth);
  const pinTextFields = el('div', { class: 'sub-body' });
  const pinStyleHint = el('p', { class: 'field-hint' });
  const syncPinStyle = () => {
    const style = st().pin.style;
    stemField.hidden = style !== 'teardrop';
    strokeField.hidden = style !== 'ring';
    pinTextFields.hidden = !TEXT_STYLES.has(style);
    pinStyleHint.textContent = PIN_STYLES.find((p) => p.id === style)?.hint || '';
  };

  pinBody.append(
    bind(segmented({
      label: 'Shape',
      wrap: true,
      options: PIN_STYLES.map((p) => ({ value: p.id, label: p.label, title: p.hint })),
      value: st().pin.style,
      onChange: (v) => { update((s) => { s.pin.style = v; }); syncPinStyle(); },
    }), (s) => s.pin.style),
    pinStyleHint,
    bind(slider({
      label: 'Pin size', min: 1, max: 25, step: 0.25, value: st().pin.radius, unit: ' mm',
      hint: 'A minimum — the shape grows if the text needs more room.',
      onInput: (v) => update((s) => { s.pin.radius = v; }),
    }), (s) => s.pin.radius),
    stemField,
    strokeField,
    pinTextFields,
    bind(toggle({
      label: 'Clear the map behind the pin', value: st().pin.clearSpace,
      onChange: (v) => update((s) => { s.pin.clearSpace = v; }),
    }), (s) => s.pin.clearSpace),
    bind(slider({ label: 'Clear space padding', min: 0, max: 4, step: 0.1, value: st().pin.clearance, unit: ' mm', onInput: (v) => update((s) => { s.pin.clearance = v; }) }), (s) => s.pin.clearance),
    el('hr', { class: 'divider' }),
    bind(toggle({
      label: 'Keep the pin at the map centre', value: st().pin.followCentre,
      onChange: (v) => update((s) => { s.pin.followCentre = v; }),
    }), (s) => s.pin.followCentre),
    row([
      placeButton,
      button({ label: 'Centre it', title: 'Move the pin to the middle of the map', onClick: () => actions.centrePin() }),
    ]),
    row([
      bind(numberInput({ label: 'Pin latitude', value: st().pin.lat, step: 0.0001, min: -85, max: 85, onInput: (v) => update((s) => { s.pin.lat = v; s.pin.followCentre = false; }) }), (s) => s.pin.lat),
      bind(numberInput({ label: 'Pin longitude', value: st().pin.lon, step: 0.0001, min: -180, max: 180, onInput: (v) => update((s) => { s.pin.lon = v; s.pin.followCentre = false; }) }), (s) => s.pin.lon),
    ], 'row row-2')
  );
  pinTextFields.append(
    bind(textInput({
      label: 'Text inside the pin', value: st().pin.text, placeholder: 'Home',
      onInput: (v) => update((s) => { s.pin.text = v; }),
    }), (s) => s.pin.text),
    bind(select({
      label: 'Pin font', options: FONT_OPTIONS, value: st().pin.font, styleOptions: true,
      onChange: (v) => update((s) => { s.pin.font = v; }, { fonts: true }),
    }), (s) => s.pin.font),
    row([
      bind(segmented({ label: 'Weight', options: WEIGHT_OPTIONS, value: st().pin.weight, onChange: (v) => update((s) => { s.pin.weight = Number(v); }, { fonts: true }) }), (s) => s.pin.weight),
      bind(select({ label: 'Capitalisation', options: CASE_OPTIONS, value: st().pin.textCase, onChange: (v) => update((s) => { s.pin.textCase = v; }) }), (s) => s.pin.textCase),
    ], 'row row-2'),
    bind(slider({ label: 'Text size', min: 1, max: 12, step: 0.1, value: st().pin.textSize, unit: ' mm', onInput: (v) => update((s) => { s.pin.textSize = v; }) }), (s) => s.pin.textSize),
    bind(slider({ label: 'Letter spacing', min: -0.2, max: 1.5, step: 0.02, value: st().pin.tracking, unit: ' mm', onInput: (v) => update((s) => { s.pin.tracking = v; }) }), (s) => s.pin.tracking),
    bind(slider({
      label: 'Nudge text up or down', min: -8, max: 8, step: 0.1, value: st().pin.textOffsetY, unit: ' mm',
      onInput: (v) => update((s) => { s.pin.textOffsetY = v; }),
    }), (s) => s.pin.textOffsetY),
    bind(toggle({
      label: 'Knock the text out of the shape',
      value: st().pin.knockout,
      hint: 'Leaves the letters unengraved, like the reference coasters.',
      onChange: (v) => update((s) => { s.pin.knockout = v; }),
    }), (s) => s.pin.knockout)
  );

  syncPinStyle();
  bindings.push({ node: { sync: syncPinStyle }, read: () => null });

  // -------------------------------------------------------------- caption
  const captionSection = section('Caption', { open: true, id: 'section-caption' });
  const captionBody = el('div', { class: 'sub-body' });
  const linesHost = el('div', { class: 'caption-lines' });

  function renderCaptionLines() {
    linesHost.replaceChildren();
    const lines = st().caption.lines;
    lines.forEach((line, index) => {
      const card = el('div', { class: 'caption-line' });
      const header = el('div', { class: 'caption-line-head' }, [
        el('span', { class: 'caption-line-index', text: `Line ${index + 1}` }),
        el('div', { class: 'caption-line-tools' }, [
          button({
            label: '↑', title: 'Move up', onClick: () => {
              if (index === 0) return;
              update((s) => { const l = s.caption.lines; [l[index - 1], l[index]] = [l[index], l[index - 1]]; });
              renderCaptionLines();
            },
          }),
          button({
            label: '↓', title: 'Move down', onClick: () => {
              if (index === lines.length - 1) return;
              update((s) => { const l = s.caption.lines; [l[index + 1], l[index]] = [l[index], l[index + 1]]; });
              renderCaptionLines();
            },
          }),
          button({
            label: '✕', title: 'Remove line', onClick: () => {
              update((s) => { s.caption.lines.splice(index, 1); });
              renderCaptionLines();
            },
          }),
        ]),
      ]);

      card.append(
        header,
        textInput({
          label: null, value: line.text, placeholder: 'Type the caption…',
          onInput: (v) => update((s) => { s.caption.lines[index].text = v; s.caption.autoFill = false; }),
        }),
        select({
          label: 'Font', options: FONT_OPTIONS, value: line.font, styleOptions: true,
          onChange: (v) => update((s) => { s.caption.lines[index].font = v; }, { fonts: true }),
        }),
        row([
          segmented({ label: 'Weight', options: WEIGHT_OPTIONS, value: line.weight, onChange: (v) => update((s) => { s.caption.lines[index].weight = Number(v); }, { fonts: true }) }),
          toggle({ label: 'Italic', value: line.italic, onChange: (v) => update((s) => { s.caption.lines[index].italic = v; }, { fonts: true }) }),
        ], 'row row-2'),
        segmented({
          label: 'Align',
          options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }],
          value: line.align,
          onChange: (v) => update((s) => { s.caption.lines[index].align = v; }),
        }),
        select({ label: 'Capitalisation', options: CASE_OPTIONS, value: line.textCase, onChange: (v) => update((s) => { s.caption.lines[index].textCase = v; }) }),
        slider({ label: 'Size', min: 1.5, max: 24, step: 0.1, value: line.size, unit: ' mm', onInput: (v) => update((s) => { s.caption.lines[index].size = v; }) }),
        slider({ label: 'Letter spacing', min: -0.3, max: 2, step: 0.02, value: line.tracking, unit: ' mm', onInput: (v) => update((s) => { s.caption.lines[index].tracking = v; }) }),
        slider({ label: 'Line spacing', min: 0.9, max: 2.5, step: 0.02, value: line.lineHeight, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => update((s) => { s.caption.lines[index].lineHeight = v; }) }),
        slider({ label: 'Nudge this line sideways', min: -40, max: 40, step: 0.25, value: line.offsetX, unit: ' mm', onInput: (v) => update((s) => { s.caption.lines[index].offsetX = v; }) })
      );
      linesHost.append(card);
    });
  }

  captionSection.body.append(
    bind(toggle({
      label: 'Show a caption', value: st().caption.enabled,
      onChange: (v) => { captionBody.hidden = !v; update((s) => { s.caption.enabled = v; }); },
    }), (s) => s.caption.enabled),
    captionBody
  );
  captionBody.hidden = !st().caption.enabled;
  bindings.push({ node: { sync: () => { captionBody.hidden = !st().caption.enabled; } }, read: () => null });

  const captionHeightNote = el('p', { class: 'field-hint', id: 'caption-height-note' });
  const captionScaleField = slider({
    label: 'Overall caption size', min: 0.35, max: 2, step: 0.01, value: st().caption.scale,
    format: (v) => `${v.toFixed(2)}×`,
    onInput: (v) => update((s) => { s.caption.scale = v; }),
  });
  captionScaleField.id = 'caption-scale';
  captionBody.append(
    bind(captionScaleField, (s) => s.caption.scale),
    captionHeightNote,
    bind(slider({
      label: 'Gap below the map', min: 0, max: 25, step: 0.25, value: st().caption.gap, unit: ' mm',
      onInput: (v) => update((s) => { s.caption.gap = v; }),
    }), (s) => s.caption.gap),
    el('p', { class: 'field-hint', text: 'Drag the caption in the preview to move it, or nudge it here.' }),
    row([
      bind(slider({
        label: 'Move left / right', min: -40, max: 40, step: 0.25, value: st().caption.offsetX, unit: ' mm',
        onInput: (v) => update((s) => { s.caption.offsetX = v; }),
      }), (s) => s.caption.offsetX),
      bind(slider({
        label: 'Move up / down', min: -60, max: 40, step: 0.25, value: st().caption.offsetY, unit: ' mm',
        onInput: (v) => update((s) => { s.caption.offsetY = v; }),
      }), (s) => s.caption.offsetY),
    ], 'row row-2'),
    row([
      button({
        label: 'Centre the caption',
        onClick: () => update((s) => { s.caption.offsetX = 0; s.caption.offsetY = 0; }),
      }),
    ]),
    linesHost,
    row([
      button({
        label: 'Add a line', onClick: () => {
          update((s) => {
            const last = s.caption.lines[s.caption.lines.length - 1];
            s.caption.lines.push(captionLine(last ? { font: last.font, size: last.size * 0.8, tracking: last.tracking } : {}));
          });
          renderCaptionLines();
        },
      }),
      button({
        label: 'Fill from location', title: 'Rewrite the caption from the current place and coordinates',
        onClick: () => { actions.fillCaptionFromLocation(); renderCaptionLines(); },
      }),
    ])
  );
  renderCaptionLines();

  // ------------------------------------------------------- style & export
  const exportSection = section('Preview & export', { open: true, id: 'section-export' });
  const statsNode = el('p', { class: 'stats' });
  const fileInput = el('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: (e) => { const f = e.target.files?.[0]; if (f) actions.loadDesign(f); e.target.value = ''; },
  });

  exportSection.body.append(
    bind(select({
      label: 'Preview finish',
      options: Object.values(PREVIEW_THEMES).map((t) => ({ value: t.id, label: t.label })),
      value: st().style.previewTheme,
      onChange: (v) => update((s) => { s.style.previewTheme = v; }),
    }), (s) => s.style.previewTheme),
    el('hr', { class: 'divider' }),
    bind(segmented({
      label: 'Line geometry',
      options: [
        { value: 'outlines', label: 'Filled shapes', title: 'Every line becomes a closed shape of the right width' },
        { value: 'strokes', label: 'Centre lines', title: 'Lines stay as strokes with a stroke-width' },
      ],
      value: st().style.geometry,
      hint: 'xTool ignores stroke widths, so filled shapes are the safe choice — a 0.2 mm street stays 0.2 mm. Centre lines make a smaller file and suit LightBurn line mode.',
      onChange: (v) => update((s) => { s.style.geometry = v; }),
    }), (s) => s.style.geometry),
    bind(segmented({
      label: 'SVG colours',
      options: [
        { value: 'mono', label: 'One colour', title: 'Everything in a single colour — one laser operation' },
        { value: 'layers', label: 'Colour per layer', title: 'Each layer gets its own colour so you can set power and speed separately' },
      ],
      value: st().style.exportColors,
      onChange: (v) => update((s) => { s.style.exportColors = v; }),
    }), (s) => s.style.exportColors),
    bind(select({
      label: 'Single colour',
      options: [
        { value: '#000000', label: 'Black' },
        { value: '#ffffff', label: 'White' },
        { value: '#ff0000', label: 'Red' },
        { value: '#0000ff', label: 'Blue' },
      ],
      value: st().style.exportInk,
      onChange: (v) => update((s) => { s.style.exportInk = v; }),
    }), (s) => s.style.exportInk),
    row([
      button({ label: 'Download SVG', variant: 'primary', onClick: () => actions.exportSvg() }),
      button({ label: 'Save design', onClick: () => actions.saveDesign() }),
    ]),
    row([
      button({ label: 'Open design', onClick: () => fileInput.click() }),
      button({
        label: 'Clear map cache',
        title: 'Forget the downloaded map data and fetch it fresh next time',
        onClick: () => actions.clearMapCache(),
      }),
    ]),
    fileInput,
    statsNode
  );

  const undoButton = button({ label: '↶ Undo', title: 'Undo the last change (Ctrl/Cmd+Z)', onClick: () => actions.undo() });
  const redoButton = button({ label: '↷ Redo', title: 'Redo (Ctrl/Cmd+Shift+Z)', onClick: () => actions.redo() });
  const resetButton = button({ label: 'Reset to defaults', title: 'Discard every setting and start from the default design', onClick: () => actions.reset() });
  const toolbar = el('div', { class: 'panel-toolbar' }, [undoButton, redoButton, resetButton]);

  panel.append(toolbar, locationSection, coasterSection, layersSection, labelsSection, pinSection, captionSection, exportSection);

  return {
    node: panel,
    setHistoryState(canUndo, canRedo) {
      undoButton.disabled = !canUndo;
      redoButton.disabled = !canRedo;
    },
    renderResults,
    renderCaptionLines,
    setStats(text) { statsNode.textContent = text; },
    setCaptionHeight(mm) {
      captionHeightNote.textContent = st().caption.enabled
        ? `The caption reserves ${mm.toFixed(1)} mm at the bottom. Shrink it to give the map more room.`
        : '';
    },
    setPinWarning(show) { pinWarning.hidden = !show; },
    setPlacingPin(active) {
      placeButton.classList.toggle('is-active', active);
      placeButton.querySelector('span:last-child').textContent = active
        ? 'Click the map… (Esc to cancel)'
        : 'Click the preview to place';
    },
    sync() {
      const state = st();
      for (const { node, read } of bindings) {
        const value = read(state);
        node.sync(value);
      }
      searchField.sync(state.location.query);
    },
  };
}
