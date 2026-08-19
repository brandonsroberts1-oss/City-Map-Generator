// File in and out: the SVG the laser wants, plus a JSON round-trip so a design
// can be reopened later.

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slugify(text, fallback = 'coaster') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

export function suggestedName(state, extension) {
  const base = slugify([state.location.label, state.location.region].filter(Boolean).join('-'));
  const size = `${Math.round(state.coaster.width)}mm`;
  return `${base}-coaster-${size}.${extension}`;
}

export function downloadSvg(markup, filename) {
  const withDeclaration = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${markup}\n`;
  triggerDownload(new Blob([withDeclaration], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

export function downloadDesign(state, filename) {
  triggerDownload(
    new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
    filename
  );
}

export function readDesignFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)));
      } catch (err) {
        reject(new Error('That file is not a saved coaster design.'));
      }
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}
