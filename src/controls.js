// Small declarative form controls. Each returns a DOM element and reports
// changes through a callback — no framework, no virtual DOM, and no re-mounting
// the panel on every keystroke (which would steal focus mid-edit).

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Wraps a sync function so it never clobbers a control the user is editing. */
function guardSync(wrapper, apply) {
  wrapper.sync = (value) => {
    if (wrapper.contains(document.activeElement)) return;
    apply(value);
  };
  return wrapper;
}

function fieldShell(label, control, hint) {
  return el('div', { class: 'field' }, [
    label ? el('label', { class: 'field-label', text: label }) : null,
    control,
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

export function slider({ label, min, max, step = 1, value, unit = '', hint, format, onInput }) {
  const readout = el('output', { class: 'slider-value' });
  const show = (v) => {
    readout.textContent = format ? format(v) : `${Number(v.toFixed(3))}${unit}`;
  };
  const input = el('input', {
    type: 'range',
    min,
    max,
    step,
    value,
    class: 'slider',
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      show(v);
      onInput(v);
    },
  });
  show(value);
  const row = el('div', { class: 'slider-row' }, [input, readout]);
  const wrapper = fieldShell(label, row, hint);
  return guardSync(wrapper, (v) => {
    input.value = v;
    show(v);
  });
}

export function numberInput({ label, min, max, step = 1, value, unit, hint, onInput }) {
  const input = el('input', {
    type: 'number',
    min,
    max,
    step,
    value,
    class: 'input number',
    onchange: (e) => {
      let v = parseFloat(e.target.value);
      if (Number.isNaN(v)) v = value;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      e.target.value = v;
      onInput(v);
    },
  });
  const row = unit ? el('div', { class: 'input-row' }, [input, el('span', { class: 'unit', text: unit })]) : input;
  const wrapper = fieldShell(label, row, hint);
  return guardSync(wrapper, (v) => {
    input.value = Number(v.toFixed(6));
  });
}

export function textInput({ label, value, placeholder, hint, onInput, onEnter }) {
  const input = el('input', {
    type: 'text',
    value: value ?? '',
    placeholder,
    class: 'input',
    oninput: (e) => onInput?.(e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter') onEnter?.(e.target.value);
    },
  });
  const wrapper = fieldShell(label, input, hint);
  wrapper.input = input;
  return guardSync(wrapper, (v) => {
    input.value = v ?? '';
  });
}

export function toggle({ label, value, hint, onChange }) {
  const input = el('input', {
    type: 'checkbox',
    class: 'checkbox',
    checked: value,
    onchange: (e) => onChange(e.target.checked),
  });
  const wrapper = el('div', { class: 'field field-toggle' }, [
    el('label', { class: 'toggle' }, [input, el('span', { class: 'toggle-label', text: label })]),
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
  wrapper.sync = (v) => {
    input.checked = Boolean(v);
  };
  return wrapper;
}

export function select({ label, options, value, hint, onChange, styleOptions = false }) {
  const node = el('select', {
    class: 'input select',
    onchange: (e) => onChange(e.target.value),
  });
  for (const opt of options) {
    const option = el('option', { value: opt.value, text: opt.label, selected: opt.value === value });
    if (styleOptions && opt.fontFamily) option.style.fontFamily = opt.fontFamily;
    node.append(option);
  }
  if (styleOptions) {
    const applyFont = () => {
      const match = options.find((o) => o.value === node.value);
      node.style.fontFamily = match?.fontFamily || '';
    };
    node.addEventListener('change', applyFont);
    applyFont();
  }
  const wrapper = fieldShell(label, node, hint);
  return guardSync(wrapper, (v) => {
    node.value = v;
  });
}

export function segmented({ label, options, value, hint, onChange }) {
  const buttons = [];
  const group = el('div', { class: 'segmented', role: 'group' });
  for (const opt of options) {
    const button = el('button', {
      type: 'button',
      class: 'segment' + (opt.value === value ? ' is-active' : ''),
      text: opt.label,
      title: opt.title || opt.label,
      onclick: () => {
        for (const b of buttons) b.classList.toggle('is-active', b.dataset.value === String(opt.value));
        onChange(opt.value);
      },
      dataset: { value: opt.value },
    });
    buttons.push(button);
    group.append(button);
  }
  const wrapper = fieldShell(label, group, hint);
  wrapper.sync = (v) => {
    for (const b of buttons) b.classList.toggle('is-active', b.dataset.value === String(v));
  };
  return wrapper;
}

export function button({ label, onClick, variant = 'ghost', title, icon }) {
  return el('button', {
    type: 'button',
    class: `btn btn-${variant}`,
    onclick: onClick,
    title: title || label,
  }, [icon ? el('span', { class: 'btn-icon', html: icon }) : null, el('span', { text: label })]);
}

export function section(title, { open = false, id, badge } = {}) {
  const body = el('div', { class: 'section-body' });
  const summary = el('summary', { class: 'section-summary' }, [
    el('span', { class: 'section-title', text: title }),
    badge ? el('span', { class: 'section-badge', text: badge }) : null,
  ]);
  const details = el('details', { class: 'section', open, id }, [summary, body]);
  details.body = body;
  return details;
}

export function row(children, className = 'row') {
  return el('div', { class: className }, children);
}
