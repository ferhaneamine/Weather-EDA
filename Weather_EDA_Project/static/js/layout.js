/* Page layout: one dashboard page at a time, grouped sidebar, prev/next links. */
(function () {
  'use strict';

  const pages = Array.from(document.querySelectorAll('.page'));
  if (!pages.length) return;
  const links = Array.from(document.querySelectorAll('#sidebar-nav .nav-link'));
  const order = links.map((a) => a.getAttribute('href').slice(1));       // page names, sidebar order
  const byName = Object.fromEntries(pages.map((p) => [p.dataset.page, p]));
  const sectionPage = {};                                                  // section id -> page name
  pages.forEach((p) => p.querySelectorAll('[id]').forEach((el) => { sectionPage[el.id] = p.dataset.page; }));

  // Current page name in the top bar
  const crumb = document.querySelector('.crumb');
  const crumbPage = document.createElement('b');
  crumbPage.className = 'crumb-page';
  if (crumb) {
    const sep = document.createElement('span');
    sep.textContent = ' / ';
    crumb.append(sep, crumbPage);
  }

  // "Previous / Next" links at the bottom of every page
  pages.forEach((p) => {
    const i = order.indexOf(p.dataset.page);
    const nav = document.createElement('div');
    nav.className = 'page-nav';
    const mk = (name, dir) => {
      const a = document.createElement('a');
      a.href = '#' + name;
      a.className = 'page-nav-link page-nav-' + dir;
      a.textContent = dir === 'prev' ? '← ' + byName[name].dataset.title : byName[name].dataset.title + ' →';
      return a;
    };
    if (i > 0) nav.append(mk(order[i - 1], 'prev'));
    if (i < order.length - 1) nav.append(mk(order[i + 1], 'next'));
    p.append(nav);
  });

  function resizeCharts(page) {
    if (!window.Plotly) return;
    page.querySelectorAll('.js-plotly-plot').forEach((gd) => {
      try { window.Plotly.Plots.resize(gd); } catch (e) { /* chart not ready yet */ }
    });
  }

  let current = null;
  function show(name, sectionId) {
    const page = byName[name] || byName[order[0]];
    if (page.dataset.page !== current) {
      pages.forEach((p) => { p.hidden = p !== page; });
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + page.dataset.page));
      crumbPage.textContent = page.dataset.title.toUpperCase();
      document.title = page.dataset.title + ' · Weather EDA';
      current = page.dataset.page;
      requestAnimationFrame(() => { resizeCharts(page); setTimeout(() => resizeCharts(page), 200); });
    }
    const target = sectionId && document.getElementById(sectionId);
    if (target && target !== page) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0 });
  }

  function route(id) {
    id = (id || '').replace(/^#/, '');
    if (byName[id]) return show(id);
    if (sectionPage[id]) return show(sectionPage[id], id);
    return show(order[0]);
  }

  window.showSection = route;                       // used by dashboard.js
  window.addEventListener('hashchange', () => route(location.hash));
  route(location.hash);
})();
