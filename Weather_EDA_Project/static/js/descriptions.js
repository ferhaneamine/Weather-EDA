/* Hand-written description boxes under every plot and table.
   Texts live in the SQLite table `descriptions` and are edited with the
   "Edit" button next to each box. */
(function () {
  'use strict';

  // key -> where to put the box. Default: right after the element with that id.
  const PLACEMENT = {
    'noise-table': (el) => el.closest('.table-wrap'),
    'anomaly-table': (el) => el.closest('.table-wrap'),
    'numerical-stats-table': (el) => el.closest('.table-wrap'),
    'categorical-stats-table': (el) => el.closest('.table-wrap'),
    'audit-table': (el) => el.closest('.table-wrap'),
    'model-fi-table': (el) => el.closest('.table-wrap'),
    'model-comparison': (el) => el.closest('.metric-comparison-grid'),
  };
  // key -> element id to look up (when the key is not itself an id)
  const ANCHOR_ID = { 'model-comparison': 'compare-mae' };

  function findAnchor(key) {
    const el = document.getElementById(ANCHOR_ID[key] || key);
    if (!el) return null;
    return (PLACEMENT[key] ? PLACEMENT[key](el) : el) || null;
  }

  async function save(key, text) {
    const res = await fetch('/api/descriptions/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('Save failed (' + res.status + ')');
    return (await res.json()).text;
  }

  function buildBox(item) {
    const box = document.createElement('div');
    box.className = 'desc-box';
    box.dataset.descKey = item.key;
    let current = item.text || '';

    function renderView() {
      box.replaceChildren();
      const p = document.createElement('p');
      p.className = 'desc-text' + (current ? '' : ' desc-empty');
      p.textContent = current || 'No description yet.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'desc-btn';
      btn.textContent = current ? 'Edit' : 'Add description';
      btn.addEventListener('click', renderEdit);
      box.append(p, btn);
    }

    function renderEdit() {
      box.replaceChildren();
      const area = document.createElement('textarea');
      area.className = 'desc-input';
      area.rows = 3;
      area.maxLength = 2000;
      area.value = current;
      area.placeholder = 'Describe this ' + (item.label.includes('table') ? 'table' : 'plot') + '…';
      const msg = document.createElement('span');
      msg.className = 'desc-msg';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'desc-btn desc-btn-primary';
      saveBtn.textContent = 'Save';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'desc-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', renderView);
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        msg.textContent = 'Saving…';
        try {
          current = await save(item.key, area.value);
          renderView();
        } catch (err) {
          msg.textContent = err.message;
          saveBtn.disabled = false;
        }
      });
      const row = document.createElement('div');
      row.className = 'desc-actions';
      row.append(saveBtn, cancelBtn, msg);
      box.append(area, row);
      area.focus();
    }

    renderView();
    return box;
  }

  async function init() {
    let items;
    try {
      const res = await fetch('/api/descriptions', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      items = await res.json();
    } catch (err) {
      console.warn('Descriptions could not be loaded:', err);
      return;
    }
    items.forEach((item) => {
      const anchor = findAnchor(item.key);
      if (!anchor) { console.warn('No element found for description key', item.key); return; }
      anchor.insertAdjacentElement('afterend', buildBox(item));
    });
  }

  init();
})();
