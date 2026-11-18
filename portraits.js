/* global Tesseract */
'use strict';

const rosterOCRFiles = {
  script: './ocr/client/tesseract.min.js',
  worker: './ocr/client/worker.min.js',
  core: './ocr/core/tesseract-core-lstm.js',
  language: './ocr/lang',
};
let ocrScript;

function loadRosterOCR() {
  if (!ocrScript) {
    ocrScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = rosterOCRFiles.script;
      script.integrity = 'sha384-r1ru3tcf6FhnCFR4B7pIFG+BhFF9LlFtz/P1y4pblWn3AGs9y3lBx5SKLNf4+rED';
      script.referrerPolicy = 'no-referrer';
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error('Le moteur de lecture est indisponible. Vérifie ta connexion et réessaie.'));
      };
      document.head.append(script);
    }).catch(error => {
      ocrScript = null;
      throw error;
    });
  }
  return ocrScript;
}

function rosterCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Choisis une capture d’écran au format JPG ou PNG.'));
    };
    img.src = url;
  });
}

function denseBands(values, threshold, minimum, gap = 2) {
  const bands = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i <= values.length + gap; i++) {
    if (values[i] >= threshold) {
      if (start === -1) start = i;
      last = i;
    } else if (start !== -1 && i - last > gap) {
      if (last + 1 - start >= minimum) bands.push([start, last + 1]);
      start = -1;
    }
  }
  return bands;
}

async function rosterTiles(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('La capture dépasse 20 Mo.');
  const image = await imageFromFile(file);
  const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
  const source = rosterCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  const {width, height} = source;
  const ctx = source.getContext('2d', {willReadFrequently: true});
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const dark = new Uint8Array(width * height);
  const rows = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const point = y * width + x;
      const i = point * 4;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 200) {
        dark[point] = 1;
        rows[y]++;
      }
    }
    if (rows[y] > 0.94 * width) rows[y] = 0;
  }
  const portraitRows = denseBands(rows, width * 0.085, Math.max(32, height * 0.045));
  const grid = portraitRows.map(([top, bottom]) => {
    const rowHeight = bottom - top;
    const cols = new Uint16Array(width);
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < width; x++) cols[x] += dark[y * width + x];
    }
    const portraits = denseBands(cols, rowHeight * 0.32, Math.max(22, width * 0.033));
    return {top, bottom, portraits};
  }).filter(row => row.portraits.length && row.portraits.every(([left, right]) => {
    const ratio = (right - left) / (row.bottom - row.top);
    return ratio >= 0.47 && ratio <= 1.37;
  }));
  const layout = grid.reduce((best, row) => row.portraits.length > best.length ? row.portraits : best, []);
  if (layout.length < 2 || grid.reduce((n, row) => n + row.portraits.length, 0) > 80) {
    throw new Error('La grille n’a pas été reconnue. Utilise une capture complète avec les photos et les noms en dessous.');
  }
  if (grid.some(row => row.portraits.some(([left, right]) =>
    !layout.some(([x, xEnd]) => Math.abs(x - left) <= 8 && Math.abs(xEnd - right) <= 10)
  ))) {
    throw new Error('Les portraits ne sont pas alignés. Recadre la capture sur la grille et réessaie.');
  }
  const tiles = [];
  for (const [i, row] of grid.entries()) {
    const portraitHeight = row.bottom - row.top;
    for (const [left, right] of row.portraits) {
      const col = layout.findIndex(([x]) => Math.abs(x - left) <= 8);
      const textLeft = Math.max(0, left - 3);
      const textRight = Math.min(width, (layout[col + 1]?.[0] ?? width) - 4);
      const textBottom = Math.min(height, grid[i + 1]?.top ?? height, row.bottom + Math.round(portraitHeight * 0.275));
      if (textBottom - row.bottom < 10) continue;
      const portraitWidth = right - left;
      const photo = rosterCanvas(84, Math.round(84 * portraitHeight / portraitWidth));
      photo.getContext('2d').drawImage(source, left, row.top, portraitWidth, portraitHeight, 0, 0, photo.width, photo.height);
      const label = rosterCanvas((textRight - textLeft) * 2 + 20, (textBottom - row.bottom) * 2 + 16);
      const labelCtx = label.getContext('2d');
      labelCtx.fillStyle = '#fff';
      labelCtx.fillRect(0, 0, label.width, label.height);
      labelCtx.drawImage(source, textLeft, row.bottom, textRight - textLeft, textBottom - row.bottom, 10, 8,
        label.width - 20, label.height - 16);
      tiles.push({photo: photo.toDataURL('image/jpeg', 0.72), label});
    }
  }
  return tiles;
}

async function readRosterTiles(tiles, onProgress) {
  await loadRosterOCR();
  let worker;
  let timer;
  let timerExpired = false;
  try {
    const started = Tesseract.createWorker('fra', 1, {
      workerPath: new URL(rosterOCRFiles.worker, location.href).href,
      corePath: new URL(rosterOCRFiles.core, location.href).href,
      langPath: new URL(rosterOCRFiles.language, location.href).href,
      workerBlobURL: false,
      errorHandler: () => {},
    }, {load_system_dawg: '0', load_freq_dawg: '0'});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timerExpired = true;
        reject(new Error('Le moteur de lecture met trop de temps à démarrer.'));
      }, 25000);
    });
    started.then(late => {
      if (timerExpired) return late.terminate();
    }).catch(() => {});
    worker = await Promise.race([started, timeout]);
    clearTimeout(timer);
    await worker.setParameters({tessedit_pageseg_mode: '6'});
    for (const [i, tile] of tiles.entries()) {
      onProgress(i + 1);
      const {data} = await worker.recognize(tile.label);
      const lines = data.text.trim().split(/\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length === 2 && /\s/.test(lines[0]) && /^\p{L}$/u.test(lines[1])) lines.pop();
      tile.name = lines.join(' ').replace(/\s+/g, ' ');
      delete tile.label;
    }
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate();
  }
}

function portraitNameKey(name) {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr')
    .replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ');
}

function suggestPortraitStudent(students, name) {
  const key = portraitNameKey(name || '');
  if (!key) return '';
  const exact = students.filter(p => portraitNameKey(p.name) === key);
  if (exact.length) return exact.length === 1 ? exact[0].id : '';
  const parts = key.split(' ');
  const alternatives = new Set(parts.slice(1).map((_, i) => [...parts.slice(i + 1), ...parts.slice(0, i + 1)].join(' ')));
  const swapped = students.filter(p => alternatives.has(portraitNameKey(p.name)));
  return swapped.length === 1 ? swapped[0].id : '';
}

function validRosterPortrait(value) {
  return typeof value === 'string' && value.length <= 30000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

(() => {
  function paragraph(text, className) {
    const el = document.createElement('p');
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function photo(portrait) {
    const el = document.createElement(validRosterPortrait(portrait) ? 'img' : 'span');
    el.className = 'pf-roster-photo';
    if (el.tagName === 'IMG') {
      el.src = portrait;
      el.alt = '';
    } else {
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '—';
    }
    return el;
  }

  function button(text, variant = '') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn ' + variant;
    element.textContent = text;
    return element;
  }

  function dialog(title) {
    const element = document.createElement('dialog');
    element.className = 'pf-roster-dialog';
    element.setAttribute('aria-label', title);
    const heading = document.createElement('h3');
    heading.textContent = title;
    element.append(heading);
    document.body.append(element);
    element.addEventListener('close', () => element.remove(), {once: true});
    return element;
  }

  function picker({runners, selected, label, select}) {
    const modal = dialog(label);
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Nom, prénom ou dossard';
    input.setAttribute('aria-label', 'Rechercher un élève');
    const list = document.createElement('div');
    list.className = 'pf-roster-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Élèves disponibles');
    const footer = document.createElement('div');
    footer.className = 'pf-roster-actions';
    const close = button('Fermer');
    close.onclick = () => modal.close();
    footer.append(close);
    if (selected) {
      const clear = button('Enlever le nom');
      clear.onclick = () => { modal.close(); select(null); };
      footer.append(clear);
    }
    modal.append(input, list, footer);
    function update() {
      const words = portraitNameKey(input.value).split(' ').filter(Boolean);
      const visible = runners.filter(r => words.every(word => portraitNameKey(`${r.name} ${r.bib}`).includes(word)));
      list.replaceChildren(...visible.map(runner => {
        const option = button('');
        option.className = 'pf-roster-choice';
        option.setAttribute('aria-pressed', String(runner.id === selected));
        const name = document.createElement('strong');
        name.textContent = runner.name;
        const meta = [runner.bib ? 'Dossard ' + runner.bib : '', runner.group ? 'Groupe ' + runner.group : ''].filter(Boolean).join(' · ');
        option.append(photo(runner.portrait), name);
        if (meta) {
          const details = document.createElement('small');
          details.textContent = meta;
          option.append(details);
        }
        option.onclick = () => { modal.close(); select(runner.id); };
        return option;
      }));
      if (!visible.length) list.append(paragraph(runners.length ? 'Aucun élève trouvé.' : 'Tous les élèves sont déjà placés.', 'help'));
    }
    input.oninput = update;
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        list.querySelector('button')?.focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        modal.close();
      }
    });
    update();
    modal.showModal();
  }

  function importRoster({file, items, itemName, save}) {
    const existing = items.length > 0;
    const candidates = items.map((item, index) => ({id: String(index), ...itemName(item.line)}));
    const modal = dialog('Importer un trombinoscope');
    const progress = paragraph('Recherche des portraits…', 'help');
    progress.setAttribute('role', 'status');
    const list = document.createElement('div');
    list.className = 'pf-roster-list';
    const footer = document.createElement('div');
    footer.className = 'pf-roster-actions';
    const close = button('Fermer');
    close.onclick = () => modal.close();
    const commit = button(existing ? 'Ajouter les portraits' : 'Créer la liste', 'ink');
    commit.disabled = true;
    footer.append(close, commit);
    modal.append(progress, list, footer);
    modal.showModal();

    (async () => {
      const tiles = await rosterTiles(file);
      if (!tiles.length) throw Error('Aucun portrait trouvé. Essaie une capture du trombinoscope avec les noms visibles.');
      let readIssue = false;
      try {
        await readRosterTiles(tiles, n => {
          progress.textContent = `Lecture des noms ${n} / ${tiles.length}…`;
        });
      } catch {
        readIssue = true;
      }
      if (!modal.open) return;
      const rows = tiles.map((tile, index) => {
        const row = document.createElement('div');
        row.className = 'pf-roster-import-row';
        row.append(photo(tile.photo));
        const label = document.createElement('label');
        label.textContent = existing ? tile.name || 'Nom illisible' : 'Nom et prénom ' + (index + 1);
        const field = document.createElement(existing ? 'select' : 'input');
        if (existing) {
          const match = suggestPortraitStudent(candidates, tile.name);
          field.append(new Option('À associer', ''), new Option('Ignorer ce portrait', '-'));
          candidates.forEach(p => field.append(new Option(p.name + (p.bib ? ' · n° ' + p.bib : ''), p.id)));
          field.value = match;
        } else {
          field.value = tile.name || '';
          field.maxLength = 120;
          field.autocomplete = 'off';
          field.placeholder = 'Laisse vide pour ignorer';
        }
        label.append(field);
        row.append(label);
        list.append(row);
        return {tile, field, row};
      });

      let savedCount = 0;
      const applied = new Set();
      function selections() {
        const counts = new Map();
        const selected = rows.filter(x => x.row.isConnected && x.field.value.trim() && x.field.value !== '-');
        for (const {field} of selected) {
          const value = existing ? field.value : portraitNameKey(field.value);
          counts.set(value, (counts.get(value) || 0) + 1);
        }
        return selected.filter(({field}) => {
          const value = existing ? field.value : portraitNameKey(field.value);
          return counts.get(value) === 1 && !applied.has(value);
        });
      }

      function update() {
        const ready = selections();
        const keep = new Set(ready);
        let pending = 0;
        for (const entry of rows) {
          if (!entry.row.isConnected) continue;
          const check = entry.field.value !== '-' && !keep.has(entry);
          entry.row.classList.toggle('pf-roster-missing', check);
          if (check) pending++;
        }
        const parts = [];
        if (readIssue) parts.push('Lecture automatique incomplète');
        if (savedCount) parts.push(`${savedCount} enregistré(s)`);
        if (ready.length) parts.push(`${ready.length} prêt(s) à enregistrer`);
        if (pending) parts.push(`${pending} à vérifier`);
        progress.textContent = parts.join(' · ') || 'Aucun portrait à enregistrer.';
        commit.disabled = !ready.length || (!existing && rows.some(x => x.field.value.trim() && !keep.has(x)));
      }
      list.addEventListener(existing ? 'change' : 'input', update);
      let currentItems = items;
      commit.onclick = () => {
        const ready = selections();
        if (!ready.length) return;
        const next = existing ? currentItems.map(item => ({...item})) : [];
        for (const {field, tile} of ready) {
          if (existing) next[Number(field.value)].portrait = tile.photo;
          else next.push({line: field.value.trim().replace(/\s+/g, ' '), g: 0, portrait: tile.photo});
        }
        if (!save(next)) {
          progress.textContent = 'Impossible d’enregistrer les portraits sur cet appareil.';
          return;
        }
        currentItems = next;
        savedCount += ready.length;
        if (!existing) { modal.close(); return; }
        for (const {field, row} of ready) {
          applied.add(field.value);
          row.remove();
        }
        for (const {field, row} of rows) if (field.value === '-') row.remove();
        if (!rows.some(x => x.row.isConnected)) modal.close();
        else update();
      };
      update();
    })().catch(error => {
      if (modal.open) progress.textContent = error.message || 'Impossible de lire la capture.';
    });
  }

  window.PhotoFinishPortraits = {photo, picker, importRoster};
})();
