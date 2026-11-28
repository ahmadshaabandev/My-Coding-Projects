// The free chart maker: /tools/chart-maker, /tools/pie-chart-maker, /tools/bar-graph-maker and
// /tools/line-graph-maker (site/partials/chart-maker.html). A small table in, one PNG out.
//
// API: POST /api/tools/chart with the chart JSON of /docs/charts answers the PNG bytes (with
// X-LTC-Warnings), or the usual { error: { code, message, details } } body; details.field names the
// field of a refused chart. Nothing is stored on the server. The endpoint is rate limited per
// network, so the preview sends at most one request every MIN_GAP_MS and only the latest input:
// whatever is typed while a request runs waits for it, and then the newest chart goes.
//
// What the visitor types is only ever set as a form value or with textContent, never parsed as
// HTML. The image is shown from a blob: URL (img-src in site/public/_headers allows blob:), and the
// same blob is the download, so "Download PNG" makes no second request.

export const API_PATH = '/api/tools/chart';
/** At most one preview request per this many milliseconds: two seconds, plus a margin for timer jitter. */
export const MIN_GAP_MS = 2100;
/** Wait this long after the last keystroke before asking for a preview. */
const TYPING_MS = 450;
/** Charts are drawn at twice their size, so they stay sharp on high-density screens and in email. */
const SCALE = 2;

export const PIE_TYPES = ['pie', 'doughnut'];
const BAR_ONLY = ['bar'];
const STACKABLE = ['bar', 'area'];

/** The example each page opens on. Replace-me data, shown as such in the table. */
const SAMPLES = {
  bar: { title: 'Orders per quarter', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '2025', data: ['120', '145', '160', '190'] }, { name: '2026', data: ['135', '170', '182', '214'] }] },
  line: { title: 'Visitors per month', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ name: 'Website', data: ['1200', '1350', '1280', '1610', '1750', '1900'] }] },
  pie: { title: 'Where orders come from', labels: ['Search', 'Email', 'Social', 'Direct'], series: [{ name: 'Orders', data: ['42', '27', '18', '13'] }] },
};
SAMPLES.area = SAMPLES.line;
SAMPLES.doughnut = SAMPLES.pie;

/* ------------------------------------------------------------------ pure helpers (tested in Node) */

const THOUSANDS = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PLAIN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/**
 * A cell's number: "1250", "-3.5", "1,250.5" (commas only between thousands), "2e3". null for an
 * empty cell, and the text itself for anything else, so the server's refusal names the field.
 */
export function cellValue(text) {
  const compact = String(text).trim().replace(/\s+/g, '');
  if (compact === '') return null;
  if (THOUSANDS.test(compact)) return Number(compact.replace(/,/g, ''));
  if (PLAIN.test(compact)) return Number(compact);
  return String(text).trim();
}

/** One line of comma-separated values; "a, b" in double quotes stays one cell, "" is a quote. */
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/**
 * Pasted text as rows of cells, or null when it is a single value (an ordinary paste). Cells are
 * split on tabs when there is one (what spreadsheets copy), else on commas when there are several
 * lines. Empty lines at the end are dropped.
 */
export function parseBlock(text) {
  const normal = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const tabs = normal.includes('\t');
  const lines = normal.split('\n');
  if (!tabs && lines.length < 2) return null;
  const rows = lines.map((line) => (tabs ? line.split('\t').map((cell) => cell.trim()) : splitCsvLine(line)));
  return rows.length > 0 && rows.some((row) => row.some((cell) => cell !== '')) ? rows : null;
}

/**
 * A pasted block with at least two columns as a whole table: the first column holds the labels,
 * the first row holds the series names when any of its other cells is not a number.
 */
export function tableFromBlock(rows, maxSeries, maxRows) {
  const width = Math.max(...rows.map((row) => row.length));
  const first = rows[0] ?? [];
  const header = first.slice(1).some((cell) => cell !== '' && typeof cellValue(cell) !== 'number');
  const body = (header ? rows.slice(1) : rows).filter((row) => row.some((cell) => cell !== ''));
  const seriesCount = Math.min(width - 1, maxSeries);
  const kept = body.slice(0, maxRows);
  return {
    names: Array.from({ length: seriesCount }, (_, i) => (header ? first[i + 1] ?? '' : '')),
    rows: kept.map((row) => ({ label: row[0] ?? '', values: Array.from({ length: seriesCount }, (_, i) => row[i + 1] ?? '') })),
    droppedSeries: width - 1 - seriesCount,
    droppedRows: body.length - kept.length,
  };
}

/**
 * The chart JSON for the API from what the form holds. Rows whose cells are all empty are left
 * out; `rowOf[i]` is the table row of data point i, so a refused point can be found again. A pie or
 * doughnut chart takes the first series only. Options are written only when they differ from the
 * API's defaults, so the copied JSON stays short.
 */
export function buildChart(form) {
  const pie = PIE_TYPES.includes(form.type);
  const rowOf = [];
  form.rows.forEach((row, index) => {
    if (row.label.trim() !== '' || row.values.some((value) => value.trim() !== '')) rowOf.push(index);
  });
  const seriesIndexes = form.names.map((_, i) => i).slice(0, pie ? 1 : undefined);
  const series = seriesIndexes.map((i) => {
    const name = (form.names[i] ?? '').trim();
    return { ...(name ? { name } : {}), data: rowOf.map((row) => cellValue(form.rows[row].values[i] ?? '')) };
  });
  const options = {};
  if (BAR_ONLY.includes(form.type) && form.horizontal) options.horizontal = true;
  if (STACKABLE.includes(form.type) && form.stacked && series.length > 1) options.stacked = true;
  if (form.values) options.values = true;
  const defaultLegend = pie || series.length > 1;
  if (form.legend !== defaultLegend) options.legend = form.legend;
  if (form.prefix !== '') options.prefix = form.prefix;
  if (form.suffix !== '') options.suffix = form.suffix;
  if (form.theme === 'dark') options.theme = 'dark';
  const chart = {
    type: form.type,
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    labels: rowOf.map((row) => form.rows[row].label.trim()),
    series,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    width: form.width,
    height: form.height,
    scale: SCALE,
  };
  return { chart, rowOf, seriesIndexes };
}

/** "Orders per quarter" -> "orders-per-quarter.png". */
export function fileName(title) {
  const slug = String(title).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'chart'}.png`;
}

/* ------------------------------------------------------------------ the page */

function start(form) {
  const $ = (id) => document.getElementById(id);
  const field = (name) => form.elements.namedItem(name);
  const table = $('chart-table');
  const frame = $('chart-frame');
  const img = $('chart-img');
  const empty = $('chart-empty');
  const status = $('chart-status');
  const errorBox = $('chart-error');
  const warningsList = $('chart-warnings');
  const download = $('chart-download');
  const copyButton = $('chart-copy');
  const jsonCode = $('chart-json-code');
  const sizeNote = $('chart-size-note');
  const pieNote = $('chart-pie-note');
  const addRow = $('chart-add-row');
  const addSeries = $('chart-add-series');
  const max = {
    series: Number(form.dataset.maxSeries),
    points: Number(form.dataset.maxPoints),
    slices: Number(form.dataset.maxSlices),
    label: Number(form.dataset.maxLabelChars),
    name: Number(form.dataset.maxNameChars),
  };

  const startType = form.closest('[data-chart-start]')?.dataset.chartStart ?? 'bar';
  const sample = SAMPLES[startType] ?? SAMPLES.bar;
  const typeInput = form.querySelector(`input[name="type"][value="${startType}"]`);
  if (typeInput) typeInput.checked = true;
  field('title').value = sample.title;

  /* ---------------- the table */

  const cellInput = (value, label, kind, maxLength) => {
    const input = document.createElement('input');
    input.className = `input chart-cell chart-cell-${kind}`;
    input.value = value;
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    input.maxLength = maxLength;
    if (kind === 'value') input.inputMode = 'decimal';
    input.dataset.kind = kind;
    return input;
  };
  const removeButton = (label, action, index, disabled) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost btn-sm chart-remove';
    button.textContent = '×';
    button.setAttribute('aria-label', label);
    button.dataset.action = action;
    button.dataset.index = String(index);
    button.disabled = disabled;
    return button;
  };

  function readTable() {
    const names = [...table.tHead.querySelectorAll('input[data-kind="name"]')].map((input) => input.value);
    const rows = [...table.tBodies[0].rows].map((tr) => ({
      label: tr.querySelector('input[data-kind="label"]').value,
      values: [...tr.querySelectorAll('input[data-kind="value"]')].map((input) => input.value),
    }));
    return { names, rows };
  }

  function renderTable(model, focus) {
    const head = document.createElement('tr');
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = 'Label';
    head.append(corner);
    model.names.forEach((name, i) => {
      const th = document.createElement('th');
      th.scope = 'col';
      const wrap = document.createElement('div');
      wrap.className = 'chart-series-head';
      wrap.append(cellInput(name, `Name of series ${i + 1}`, 'name', max.name), removeButton(`Remove series ${i + 1}`, 'remove-series', i, model.names.length <= 1));
      th.append(wrap);
      head.append(th);
    });
    const tail = document.createElement('th');
    tail.scope = 'col';
    const tailText = document.createElement('span');
    tailText.className = 'visually-hidden';
    tailText.textContent = 'Remove row';
    tail.append(tailText);
    head.append(tail);
    table.tHead.replaceChildren(head);

    const rows = model.rows.map((row, r) => {
      const tr = document.createElement('tr');
      const labelCell = document.createElement('td');
      labelCell.append(cellInput(row.label, `Label, row ${r + 1}`, 'label', max.label));
      tr.append(labelCell);
      model.names.forEach((_, i) => {
        const td = document.createElement('td');
        td.append(cellInput(row.values[i] ?? '', `Row ${r + 1}, series ${i + 1}`, 'value', 40));
        tr.append(td);
      });
      const td = document.createElement('td');
      td.append(removeButton(`Remove row ${r + 1}`, 'remove-row', r, model.rows.length <= 1));
      tr.append(td);
      return tr;
    });
    table.tBodies[0].replaceChildren(...rows);
    if (focus) focusCell(focus.row, focus.col);
    syncControls();
  }

  /** col -1 is the label column; row -1 the header row. */
  function focusCell(row, col) {
    const target =
      row < 0
        ? table.tHead.querySelectorAll('input[data-kind="name"]')[col]
        : table.tBodies[0].rows[row]?.querySelectorAll('input')[col + 1];
    (target ?? addRow).focus();
  }

  const position = (input) => {
    const tr = input.closest('tr');
    const inputs = [...tr.querySelectorAll('input')];
    const index = inputs.indexOf(input);
    return tr.parentElement === table.tHead ? { row: -1, col: index } : { row: tr.sectionRowIndex, col: index - 1 };
  };

  /* ---------------- the form */

  const checkedValue = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;

  function readForm() {
    const [width, height] = field('size').value.split('x').map(Number);
    return {
      type: checkedValue('type') ?? 'bar',
      title: field('title').value,
      ...readTable(),
      stacked: field('stacked').checked,
      horizontal: field('horizontal').checked,
      values: field('values').checked,
      legend: field('legend').checked,
      prefix: field('prefix').value,
      suffix: field('suffix').value,
      theme: checkedValue('theme') ?? 'light',
      width,
      height,
    };
  }

  function syncControls() {
    const values = readForm();
    const pie = PIE_TYPES.includes(values.type);
    const rowLimit = pie ? max.slices : max.points;
    addRow.disabled = values.rows.length >= rowLimit;
    addSeries.disabled = values.names.length >= max.series;
    field('horizontal').disabled = !BAR_ONLY.includes(values.type);
    field('stacked').disabled = !STACKABLE.includes(values.type);
    table.classList.toggle('is-pie', pie && values.names.length > 1);
    const firstName = values.names[0]?.trim() || 'Series 1';
    pieNote.hidden = !(pie && values.names.length > 1);
    pieNote.textContent = `A ${values.type} chart shows one series: the first column, “${firstName}”. The other columns stay in the table for the other chart types.`;
    frame.style.aspectRatio = `${values.width} / ${values.height}`;
  }

  /* ---------------- the preview, at most one request every MIN_GAP_MS */

  let current = buildChart(readForm());
  let lastText = '';
  let lastStart = -Infinity;
  let retryAt = 0;
  let timer = null;
  let inFlight = false;
  let again = false;
  let imageUrl = null;

  const setStatus = (text) => {
    status.textContent = text;
  };

  function clearInvalid() {
    for (const element of form.querySelectorAll('[aria-invalid="true"]')) element.removeAttribute('aria-invalid');
  }

  /** The form control a refused field stands for, and words for where it is. */
  function locate(field, sent) {
    const point = /^series\[(\d+)\]\.data\[(\d+)\]$/.exec(field);
    if (point) {
      const series = sent.seriesIndexes[Number(point[1])] ?? 0;
      const row = sent.rowOf[Number(point[2])] ?? 0;
      return { element: table.tBodies[0].rows[row]?.querySelectorAll('input[data-kind="value"]')[series], where: `Row ${row + 1}, series ${series + 1}.` };
    }
    const name = /^series\[(\d+)\]\.name$/.exec(field);
    if (name) {
      const series = sent.seriesIndexes[Number(name[1])] ?? 0;
      return { element: table.tHead.querySelectorAll('input[data-kind="name"]')[series], where: `The name of series ${series + 1}.` };
    }
    const label = /^labels\[(\d+)\]$/.exec(field);
    if (label) {
      const row = sent.rowOf[Number(label[1])] ?? 0;
      return { element: table.tBodies[0].rows[row]?.querySelector('input[data-kind="label"]'), where: `The label of row ${row + 1}.` };
    }
    const own = { title: 'title', 'options.prefix': 'prefix', 'options.suffix': 'suffix' }[field];
    return own ? { element: field(own), where: '' } : { element: null, where: '' };
  }

  function showError(lines) {
    errorBox.replaceChildren(
      ...lines.filter(Boolean).map((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        return p;
      }),
    );
    errorBox.hidden = false;
    frame.classList.toggle('is-stale', !img.hidden);
  }

  function hideError() {
    errorBox.hidden = true;
    errorBox.replaceChildren();
    frame.classList.remove('is-stale');
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    const now = performance.now();
    timer = setTimeout(send, Math.max(delay, lastStart + MIN_GAP_MS - now, retryAt - now, 0));
  }

  function changed() {
    syncControls();
    current = buildChart(readForm());
    jsonCode.textContent = JSON.stringify(current.chart, null, 2);
    const text = JSON.stringify(current.chart);
    if (text === lastText && !inFlight) return;
    // Until the newest input is drawn, the preview does not claim to be up to date.
    if (text !== lastText) setStatus('Drawing the chart…');
    if (inFlight) again = true;
    else schedule(TYPING_MS);
  }

  async function send() {
    timer = null;
    if (inFlight) {
      again = true;
      return;
    }
    const sent = current;
    const text = JSON.stringify(sent.chart);
    if (text === lastText) return;
    inFlight = true;
    lastStart = performance.now();
    lastText = text;
    setStatus('Drawing the chart…');
    let response = null;
    try {
      response = await fetch(API_PATH, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'image/png, application/json' }, body: text, credentials: 'same-origin' });
    } catch {
      response = null;
    }
    try {
      await handle(response, sent, text);
    } finally {
      inFlight = false;
      if (again || JSON.stringify(current.chart) !== lastText) {
        again = false;
        schedule(0);
      }
    }
  }

  async function handle(response, sent, text) {
    clearInvalid();
    if (!response) {
      setStatus('');
      showError(['The chart could not be sent. Check your connection; the preview tries again with your next change.']);
      return;
    }
    if (response.ok && (response.headers.get('content-type') ?? '').startsWith('image/png')) {
      const blob = await response.blob();
      await showImage(blob, sent);
      hideError();
      showWarnings(response.headers.get('x-ltc-warnings'));
      setStatus(JSON.stringify(current.chart) === text ? 'The preview is up to date.' : 'Drawing the chart…');
      return;
    }
    const body = await response.json().catch(() => null);
    const error = body?.error ?? {};
    const message = typeof error.message === 'string' ? error.message : '';
    setStatus('');
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after')) || 60;
      retryAt = performance.now() + seconds * 1000;
      lastText = '';
      showError([`Too many previews from your network in a short time. The preview updates again in about ${seconds} seconds, with your latest changes.`]);
      return;
    }
    if (error.code === 'not_configured') {
      showError(['The chart maker is not switched on here at the moment, so no chart can be drawn.']);
      return;
    }
    if (response.status === 400 || response.status === 413 || response.status === 422) {
      const path = typeof error.details?.field === 'string' ? error.details.field : '';
      const found = path ? locate(path, sent) : { element: null, where: '' };
      found.element?.setAttribute('aria-invalid', 'true');
      showError([`This chart cannot be drawn: ${message || `the server answered ${response.status}.`}`, found.where, img.hidden ? '' : 'The preview shows the last chart that could be drawn.']);
      return;
    }
    showError([`The server could not draw the chart (${response.status}${message ? `: ${message}` : ''}). The preview tries again with your next change.`]);
  }

  function showImage(blob, sent) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const next = new Image();
      next.onload = () => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = url;
        img.src = url;
        img.alt = describe(sent.chart);
        img.hidden = false;
        empty.hidden = true;
        download.href = url;
        download.download = fileName(sent.chart.title ?? '');
        download.removeAttribute('aria-disabled');
        sizeNote.textContent = `PNG, ${next.naturalWidth} x ${next.naturalHeight} pixels: twice the chart's size, so it stays sharp on high-density screens. In an email, show it ${sent.chart.width} pixels wide.`;
        resolve();
      };
      next.onerror = () => {
        URL.revokeObjectURL(url);
        showError(['The server sent an image this browser could not show.']);
        resolve();
      };
      next.src = url;
    });
  }

  function describe(chart) {
    const kind = { bar: 'Bar chart', line: 'Line chart', area: 'Area chart', pie: 'Pie chart', doughnut: 'Doughnut chart' }[chart.type] ?? 'Chart';
    const names = chart.series.map((series, i) => series.name ?? `Series ${i + 1}`).join(', ');
    return `${kind}${chart.title ? `: ${chart.title}` : ''}. ${chart.labels.length} labels; ${names}.`;
  }

  function showWarnings(header) {
    let warnings = [];
    try {
      const parsed = header ? JSON.parse(decodeURIComponent(header)) : [];
      warnings = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      warnings = [];
    }
    warningsList.replaceChildren(
      ...warnings.map((warning) => {
        const li = document.createElement('li');
        li.textContent = warning;
        return li;
      }),
    );
    warningsList.hidden = warnings.length === 0;
  }

  /* ---------------- events */

  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);

  download.addEventListener('click', (event) => {
    if (download.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });

  copyButton.addEventListener('click', async () => {
    const text = JSON.stringify(current.chart, null, 2);
    const label = 'Copy chart JSON';
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copied';
    } catch {
      // No clipboard access: open the JSON and select it, for Ctrl+C.
      jsonCode.textContent = text;
      jsonCode.closest('details').open = true;
      const range = document.createRange();
      range.selectNodeContents(jsonCode);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copyButton.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => {
      copyButton.textContent = label;
    }, 1600);
  });

  addRow.addEventListener('click', () => {
    const model = readTable();
    model.rows.push({ label: '', values: model.names.map(() => '') });
    renderTable(model, { row: model.rows.length - 1, col: -1 });
    changed();
  });

  addSeries.addEventListener('click', () => {
    const model = readTable();
    model.names.push(`Series ${model.names.length + 1}`);
    for (const row of model.rows) row.values.push('');
    renderTable(model, { row: -1, col: model.names.length - 1 });
    changed();
  });

  table.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const model = readTable();
    const index = Number(button.dataset.index);
    if (button.dataset.action === 'remove-row') {
      model.rows.splice(index, 1);
      renderTable(model, { row: Math.min(index, model.rows.length - 1), col: -1 });
    } else {
      model.names.splice(index, 1);
      for (const row of model.rows) row.values.splice(index, 1);
      renderTable(model, { row: -1, col: Math.min(index, model.names.length - 1) });
    }
    changed();
  });

  // Enter moves down a row, like a spreadsheet, and adds a row at the end.
  table.addEventListener('keydown', (event) => {
    const input = event.target.closest('input');
    if (!input || event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const { row, col } = position(input);
    if (row + 1 < table.tBodies[0].rows.length) return focusCell(row + 1, col);
    if (addRow.disabled) return;
    const model = readTable();
    model.rows.push({ label: '', values: model.names.map(() => '') });
    renderTable(model, { row: model.rows.length - 1, col });
    changed();
  });

  table.addEventListener('paste', (event) => {
    const input = event.target.closest('input');
    const rows = input ? parseBlock(event.clipboardData?.getData('text/plain') ?? '') : null;
    if (!rows) return;
    event.preventDefault();
    const pie = PIE_TYPES.includes(checkedValue('type'));
    const rowLimit = pie ? max.slices : max.points;
    const width = Math.max(...rows.map((row) => row.length));
    let message = '';
    if (width >= 2) {
      const block = tableFromBlock(rows, max.series, rowLimit);
      if (block.rows.length === 0 || block.names.length === 0) return;
      renderTable(block, { row: 0, col: -1 });
      const dropped = [block.droppedSeries > 0 ? `${block.droppedSeries} series` : '', block.droppedRows > 0 ? `${block.droppedRows} rows` : ''].filter(Boolean).join(' and ');
      message = `Pasted ${block.rows.length} rows and ${block.names.length} series.${dropped ? ` ${dropped} did not fit and were left out.` : ''}`;
    } else {
      // One column: it fills the column of the cell, downwards, adding rows as needed.
      const { row, col } = position(input);
      const model = readTable();
      const from = Math.max(row, 0);
      const values = rows.map((cells) => cells[0] ?? '').slice(0, Math.max(rowLimit - from, 0));
      values.forEach((value, i) => {
        const target = model.rows[from + i] ?? (model.rows[from + i] = { label: '', values: model.names.map(() => '') });
        if (row >= 0 && col < 0) target.label = value;
        else target.values[col] = value;
      });
      renderTable(model, { row: from, col });
    }
    changed();
    // Said after changed(), which reports that a new preview is on its way.
    if (message) setStatus(message);
  });

  renderTable({ names: sample.series.map((series) => series.name), rows: sample.labels.map((label, r) => ({ label, values: sample.series.map((series) => series.data[r]) })) });
  current = buildChart(readForm());
  jsonCode.textContent = JSON.stringify(current.chart, null, 2);
  schedule(0);
}

const chartForm = typeof document === 'undefined' ? null : document.getElementById('chart-form');
if (chartForm) start(chartForm);
