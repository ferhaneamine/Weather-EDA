/* Dataset cards on the Overview page. Clicking a card opens its first rows. */
(function () {
  'use strict';
  const grid = document.getElementById('dataset-grid');
  if (!grid) return;

  const PAGE_SIZE = 20;
  const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
  let dialog = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildDialog() {
    const dlg = el('dialog', 'ds-dialog');
    const head = el('div', 'ds-head');
    const titles = el('div');
    titles.append(el('h3', 'ds-title'), el('p', 'ds-meta'));
    const close = el('button', 'ds-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => dlg.close());
    head.append(titles, close);

    const wrap = el('div', 'ds-table-wrap');
    const table = el('table', 'ds-table');
    table.append(el('thead'), el('tbody'));
    wrap.append(table);

    const foot = el('div', 'ds-foot');
    const note = el('span', 'ds-note');
    const pager = el('div', 'ds-pager');
    const prev = el('button', 'ds-btn', '← Previous');
    const label = el('span', 'ds-page');
    const next = el('button', 'ds-btn', 'Next →');
    prev.type = next.type = 'button';
    pager.append(prev, label, next);
    foot.append(note, pager);

    dlg.append(head, wrap, foot);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // click on the backdrop
    document.body.append(dlg);
    dlg.refs = { title: titles.children[0], meta: titles.children[1], wrap, table, note, pager, prev, next, label };
    return dlg;
  }

  function showTable(dlg, data) {
    const { table, wrap, note, pager, prev, next, label } = dlg.refs;
    const preview = data.preview;
    table.tHead.replaceChildren();
    table.tBodies[0].replaceChildren();
    if (!preview || !preview.rows.length) {
      note.textContent = 'No preview is stored for this dataset. Run: python register_datasets.py --builtin';
      pager.hidden = true;
      return;
    }
    const pages = Math.ceil(preview.rows.length / PAGE_SIZE);
    let page = 0;
    const headRow = el('tr');
    headRow.append(el('th', 'ds-index', '#'));
    preview.columns.forEach((c) => headRow.append(el('th', null, c)));
    table.tHead.append(headRow);

    note.textContent = data.rows > preview.rows.length
      ? 'Showing the first ' + fmt(preview.rows.length) + ' of ' + fmt(data.rows) + ' rows'
      : 'All ' + fmt(data.rows) + ' rows';
    pager.hidden = pages < 2;

    function draw() {
      const body = table.tBodies[0];
      body.replaceChildren();
      const start = page * PAGE_SIZE;
      preview.rows.slice(start, start + PAGE_SIZE).forEach((row, i) => {
        const tr = el('tr');
        tr.append(el('td', 'ds-index', String(start + i + 1)));
        row.forEach((v) => {
          const td = el('td', typeof v === 'number' ? 'ds-num' : null, v == null ? '' : String(v));
          tr.append(td);
        });
        body.append(tr);
      });
      label.textContent = 'Page ' + (page + 1) + ' of ' + pages;
      prev.disabled = page === 0;
      next.disabled = page === pages - 1;
      wrap.scrollTop = 0;
    }
    prev.onclick = () => { if (page > 0) { page -= 1; draw(); } };
    next.onclick = () => { if (page < pages - 1) { page += 1; draw(); } };
    draw();
  }

  async function openDataset(item) {
    dialog = dialog || buildDialog();
    const { title, meta, note, pager, table } = dialog.refs;
    title.textContent = item.name;
    meta.textContent = fmt(item.rows) + ' rows × ' + fmt(item.columns) + ' columns';
    table.tHead.replaceChildren();
    table.tBodies[0].replaceChildren();
    note.textContent = 'Loading…';
    pager.hidden = true;
    if (!dialog.open) dialog.showModal();
    try {
      const res = await fetch('/api/datasets/' + item.id, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      showTable(dialog, await res.json());
    } catch (err) {
      note.textContent = 'The dataset could not be loaded.';
    }
  }

  fetch('/api/datasets', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
    .then((items) => {
      grid.replaceChildren(...items.map((it) => {
        const card = el('button', 'dataset-card');
        card.type = 'button';
        card.append(
          el('span', 'dataset-name', it.name),
          el('span', 'dataset-size', fmt(it.rows) + ' rows × ' + fmt(it.columns) + ' columns'),
          el('span', 'dataset-open', 'View data →'));
        card.addEventListener('click', () => openDataset(it));
        return card;
      }));
      if (!items.length) grid.closest('section').hidden = true;
    })
    .catch((err) => { console.warn('Datasets could not be loaded:', err); grid.closest('section').hidden = true; });
})();
