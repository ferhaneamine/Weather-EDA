/**
 * Weather Atlas · Advanced EDA Dashboard JavaScript
 * Handles real-time interactive Plotly visualizations, statistical tables,
 * KDE gallery views, outlier inspection, and model comparisons.
 */

const PALETTE = {
  teal: '#257d70',
  tealDark: '#16574e',
  tealLight: '#e4f3f0',
  blue: '#3b78ab',
  blueLight: '#e9f2f8',
  amber: '#d99726',
  amberLight: '#fdf4e4',
  coral: '#d65f49',
  coralLight: '#faece9',
  purple: '#8453b8',
  purpleLight: '#f3ecfa',
  ink: '#192f2c',
  muted: '#6a7e7b',
  border: '#e1e9e5',
  grid: '#edf2f0'
};

const FEATURE_COLORS = {
  'Temperature (C)': '#d65f49',
  'Apparent Temperature (C)': '#e68438',
  'Humidity': '#257d70',
  'Wind Speed (km/h)': '#3b78ab',
  'Wind Bearing (degrees)': '#8453b8',
  'Visibility (km)': '#209e7c',
  'Pressure (millibars)': '#2c4559',
  'Loud Cover': '#8a9b98'
};

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  toImageButtonOptions: {
    format: 'png',
    filename: 'weather-atlas-export',
    scale: 2
  }
};

let report = null;
let currentShapeMode = 'box';
let currentStatsView = 'numerical';
let currentKdeView = 'grid';
let currentStatsSort = { column: 'feature', direction: 'asc' };
let noisePage = 0;
let anomalyPage = 0;
const FLAG_PAGE_SIZE = 200;

const byId = id => document.getElementById(id);

const fmt = (val, digits = 2) => {
  if (val == null || isNaN(val)) return '—';
  return Number(val).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
};

const compact = val => {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(val || 0);
};

const escapeHtml = str => {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
};

const layoutBase = {
  font: { family: 'DM Sans, -apple-system, BlinkMacSystemFont, sans-serif', color: PALETTE.muted, size: 11 },
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  margin: { l: 52, r: 24, t: 24, b: 48 },
  hoverlabel: {
    bgcolor: '#122a27',
    bordercolor: '#28554f',
    font: { color: '#ffffff', size: 11, family: 'DM Sans, sans-serif' }
  },
  xaxis: {
    gridcolor: PALETTE.grid,
    zerolinecolor: PALETTE.grid,
    linecolor: PALETTE.border,
    tickfont: { size: 10, color: PALETTE.muted }
  },
  yaxis: {
    gridcolor: PALETTE.grid,
    zerolinecolor: PALETTE.grid,
    linecolor: PALETTE.border,
    tickfont: { size: 10, color: PALETTE.muted }
  },
  showlegend: true,
  legend: {
    orientation: 'h',
    y: 1.14,
    x: 0,
    font: { size: 10 }
  }
};

function plot(elementId, traces, layoutOverrides = {}) {
  const container = byId(elementId);
  if (!container) return;
  const mergedLayout = {
    ...structuredClone(layoutBase),
    ...layoutOverrides
  };
  Plotly.react(container, traces, mergedLayout, { ...PLOT_CONFIG, scrollZoom: false });
}

function optionList(selectElement, items, labelFn = v => v) {
  if (!selectElement) return;
  selectElement.innerHTML = items
    .map(val => `<option value="${escapeHtml(val)}">${escapeHtml(labelFn(val))}</option>`)
    .join('');
}

function showError(message) {
  const errBox = byId('load-error');
  if (errBox) {
    errBox.textContent = message;
    errBox.hidden = false;
  }
}

// ==========================================
// 1. Overview KPIs
// ==========================================
function initOverview() {
  const ov = report.dataset_overview;
  const md = report.missing_data;
  const noise = report.noise_detection;
  const anom = report.anomaly_detection;

  byId('rows-value').textContent = compact(ov.row_count);
  byId('cols-value').textContent = ov.column_count;
  byId('missing-value').textContent = compact(md.overall_missing_cells);
  byId('missing-foot').textContent = `${fmt(md.overall_missing_percentage, 3)}% of total cells (${fmt(md.overall_missing_cells, 0)} cells)`;

  const totalHampel = Object.values(noise.features).reduce((acc, feat) => acc + (feat.flag_count || 0), 0);
  byId('flags-value').textContent = compact(totalHampel);

  if (byId('anomalies-value') && anom) {
    byId('anomalies-value').textContent = compact(anom.flag_count);
    byId('anomalies-foot').textContent = `${fmt(anom.flag_percentage, 2)}% of ${fmt(anom.complete_case_count, 0)} complete cases`;
  }

  const genDate = new Date(report.metadata.generated_at_utc);
  byId('generated-at').textContent = `Generated: ${genDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC`;
  byId('sidebar-meta').textContent = `${compact(ov.row_count)} records · ${ov.column_count} features`;
  byId('footer-hash').textContent = `SHA-256 Fingerprint: ${(report.metadata.dataset_sha256 || '').slice(0, 24)}…`;
  const kpiGrid = byId('metric-cards');
  if (kpiGrid && !byId('overview-interpretation-guide')) {
    const guide = document.createElement('div');
    guide.id = 'overview-interpretation-guide';
    guide.className = 'interpretation-card';
    guide.innerHTML = `<strong>How to interpret the overview</strong><br>${fmt(ov.row_count, 0)} rows describe the dataset size; missing cells are ${fmt(md.overall_missing_percentage, 3)}% of all cells. Hampel and Mahalanobis totals are statistical flags, not counts of confirmed errors.`;
    kpiGrid.insertAdjacentElement('afterend', guide);
  }
}

function renderTemporalAnalysis() {
  const t = report.temporal_analysis;
  const host = byId('temporal-metrics');
  if (!host || !t || t.status !== 'ok') return;
  const h = t.hourly_interval_check;
  const cards = [
    ['UTC COVERAGE', `${t.start.slice(0, 10)} — ${t.end.slice(0, 10)}`, `${fmt(t.valid_timestamp_count, 0)} parseable timestamps`],
    ['UNIQUE TIMESTAMPS', fmt(t.unique_timestamp_count, 0), `${fmt(t.duplicate_timestamp_count, 0)} duplicate timestamp rows`],
    ['GAPS OVER 1 HOUR', fmt(h.gap_count_over_one_hour, 0), `Largest gap: ${h.largest_gap ? h.largest_gap.replace(' days', 'd').replace(' hours', 'h') : 'none'}`]
  ];
  host.innerHTML = cards.map(([label, value, foot]) => `<article class="metric-card"><div class="metric-top"><span>${label}</span></div><strong class="metric-value">${escapeHtml(value)}</strong><div class="metric-foot">${escapeHtml(foot)}</div></article>`).join('');
  plot('monthly-chart', [{type:'bar', x:t.monthly_counts.months, y:t.monthly_counts.counts, marker:{color:PALETTE.teal}, hovertemplate:'%{x}<br>%{y:,} rows<extra></extra>'}], {showlegend:false, xaxis:{...layoutBase.xaxis, tickangle:-35, title:{text:'Month'}}, yaxis:{...layoutBase.yaxis, title:{text:'Rows'}}});
  plot('hourly-chart', [{type:'bar', x:t.hourly_counts.hours, y:t.hourly_counts.counts, marker:{color:PALETTE.blue}, hovertemplate:'UTC %{x}:00<br>%{y:,} rows<extra></extra>'}], {showlegend:false, xaxis:{...layoutBase.xaxis, dtick:1, title:{text:'Hour (UTC)'}}, yaxis:{...layoutBase.yaxis, title:{text:'Rows'}}});
  byId('temporal-note').textContent = `${h.exact_one_hour_intervals.toLocaleString()} of ${h.interval_count.toLocaleString()} intervals between unique timestamps are exactly one hour. ${h.non_hourly_intervals.toLocaleString()} are not; gaps may reflect dataset coverage or cadence and should be checked against the source before interpreting them as missing observations.`;
  setChartInterpretation('monthly-chart', 'Higher bars mean more records in that UTC calendar month; they do not imply that the weather was more common or more severe.');
  setChartInterpretation('hourly-chart', 'Uneven counts can result from offset normalization, daylight-saving transitions in the source, or missing coverage.');
}

function setChartInterpretation(elementId, message) {
  const plotElement = byId(elementId);
  if (!plotElement) return;
  let note = byId(`${elementId}-interpretation`);
  if (!note) {
    note = document.createElement('p');
    note.id = `${elementId}-interpretation`;
    note.className = 'chart-interpretation';
    plotElement.insertAdjacentElement('afterend', note);
  }
  note.textContent = message;
}

function renderInterpretationGuides() {
  const corr = report.correlation_analysis.target_correlations || [];
  const strongest = corr.filter(x => x.pearson != null).sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson))[0];
  const audit = report.descriptive_statistics.numerical;
  const pressureZeros = audit['Pressure (millibars)']?.zero_count || 0;
  const humidityZeros = audit.Humidity?.zero_count || 0;
  const guides = {
    temporal: 'Interpretation: hourly and monthly counts show when the archive is dense or sparse. A gap is a break between recorded timestamps, not proof that a particular weather observation is missing.',
    description: 'Interpretation: the mean is sensitive to extreme values, while the median and IQR describe the center and middle half more robustly. Skew and zero counts help identify distributions that deserve a closer look; they do not by themselves mark data as invalid.',
    audit: `Interpretation: ${pressureZeros.toLocaleString()} zero pressure values and ${humidityZeros.toLocaleString()} zero humidity values are review flags. Their cause cannot be established from this file alone; consult the source conventions before changing them.`,
    'all-kde': 'Interpretation: KDE curves smooth the observed distributions. Multiple peaks can suggest subgroups or recurring regimes; the curve depends on bandwidth and should be read alongside the histogram and sample size.',
    distributions: 'Interpretation: use the histogram for observed bin counts and the KDE for a smoothed shape. The box plot summarizes median and quartiles; points beyond 1.5×IQR fences are statistical outliers, not necessarily errors.',
    relationships: strongest ? `Interpretation: the largest absolute Pearson association with temperature is ${strongest.feature} (r = ${fmt(strongest.pearson, 3)}). Association is not causation, and shared time patterns or derived measurements can produce strong correlations.` : 'Interpretation: correlation measures association, not cause. Constant features and insufficient paired values may have no coefficient.',
    quality: 'Interpretation: Hampel flags are local deviations from a rolling median; Mahalanobis flags are unusual multivariate combinations under an approximate distributional assumption. Both are candidates for inspection, not automatic deletions.',
    models: 'Interpretation: compare every model on the same future holdout. MAE is average absolute error in °C; RMSE penalizes larger misses; R² compares variance explained. The calendar baseline is the minimum seasonal reference to beat. Date-derived annual sine and cosine inputs encode the day of year as a circle, so late December and early January are treated as neighbors; they are engineered model inputs, not original CSV columns.'
  };
  for (const [id, message] of Object.entries(guides)) {
    const section = byId(id);
    const heading = section?.querySelector('.section-heading');
    if (!heading) continue;
    let card = byId(`${id}-interpretation-guide`);
    if (!card) {
      card = document.createElement('div');
      card.id = `${id}-interpretation-guide`;
      card.className = 'interpretation-card';
      heading.insertAdjacentElement('afterend', card);
    }
    card.innerHTML = `<strong>How to interpret this section</strong><br>${escapeHtml(message.replace(/^Interpretation:\s*/, ''))}`;
  }
  setChartInterpretation('kde-overlay-chart', 'The x-axis is measured in standard deviations from each feature’s mean. Similar shapes indicate similar standardized distributions, not similar units or ranges.');
  setChartInterpretation('category-chart', 'Bar length compares category frequency. Rare classes may still matter for unusual events and are not automatically unimportant.');
  setChartInterpretation('missing-chart', 'Missingness is measured per column. A missing value is distinct from a recorded zero; investigate whether missingness follows a pattern before imputing.');
  setChartInterpretation('missing-matrix-chart', 'Each row is a deterministic sample from the file. Repeated amber patterns may indicate related missing fields, but this sampled matrix is not a substitute for the full counts.');
  setChartInterpretation('correlation-chart', 'Red indicates negative association, teal positive association, and pale cells weak association. Pearson captures linear relationships; Spearman uses ranks and can capture monotonic relationships.');
  setChartInterpretation('hampel-chart', 'A flagged point differs from its nearby rolling median by more than the configured 3×scaled-MAD threshold. Step changes and sharp weather events can also trigger flags.');
  setChartInterpretation('anomaly-chart', 'Bars show the distribution of squared multivariate distances; the vertical line is an approximate 99% chi-square cutoff. Exceeding it means unusual relative to the fitted covariance, not physically impossible.');
  setChartInterpretation('impurity-chart', 'MDI scores sum to one and show how often splits using a feature reduce tree error. Correlated and high-cardinality features can receive inflated or shared importance.');
  setChartInterpretation('permutation-chart', 'A larger positive held-out R² decrease means shuffling that feature hurt predictions more. Near-zero or negative values indicate little measured contribution on this test sample.');
  setChartInterpretation('model-fi-table', 'The leaderboard combines MDI (tree split usage) with permutation importance (test-score change after shuffling). The small label under each feature identifies whether it came from a source column or was engineered from the timestamp.');
}

// ==========================================
// 2. Data Description (Min, Max, Quartiles, Mean, Skewness...)
// ==========================================
function renderDataDescription() {
  renderNumericalStatsTable();
  renderCategoricalStatsTable();
}

function renderNumericalStatsTable() {
  const numStats = report.descriptive_statistics.numerical;
  const tbody = byId('numerical-stats-tbody');
  if (!tbody) return;

  const searchTerm = (byId('stats-search')?.value || '').trim().toLowerCase();
  let entries = Object.keys(numStats).map(name => ({
    name,
    ...numStats[name]
  }));

  if (searchTerm) {
    entries = entries.filter(e => e.name.toLowerCase().includes(searchTerm));
  }

  // Sorting
  const { column, direction } = currentStatsSort;
  entries.sort((a, b) => {
    let valA, valB;
    switch (column) {
      case 'feature': valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); break;
      case 'count': valA = a.count; valB = b.count; break;
      case 'mean': valA = a.mean; valB = b.mean; break;
      case 'std': valA = a.std; valB = b.std; break;
      case 'min': valA = a.min; valB = b.min; break;
      case 'q1': valA = a.q1; valB = b.q1; break;
      case 'median': valA = a.median; valB = b.median; break;
      case 'q3': valA = a.q3; valB = b.q3; break;
      case 'max': valA = a.max; valB = b.max; break;
      case 'iqr': valA = a.iqr; valB = b.iqr; break;
      case 'skewness': valA = Math.abs(a.skewness || 0); valB = Math.abs(b.skewness || 0); break;
      case 'zeros': valA = a.zero_count; valB = b.zero_count; break;
      default: valA = a.name; valB = b.name;
    }
    if (valA < valB) return direction === 'asc' ? -1 : 1;
    if (valA > valB) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  const totalRows = report.dataset_overview.row_count;

  tbody.innerHTML = entries.map(item => {
    const isZeroSpread = item.min === item.max;
    const totalSpan = item.max - item.min;

    // Visual range calculation (percentages)
    let q1Pct = 0, medPct = 50, q3Pct = 100;
    if (!isZeroSpread && totalSpan > 0) {
      q1Pct = Math.max(0, Math.min(100, ((item.q1 - item.min) / totalSpan) * 100));
      medPct = Math.max(0, Math.min(100, ((item.median - item.min) / totalSpan) * 100));
      q3Pct = Math.max(0, Math.min(100, ((item.q3 - item.min) / totalSpan) * 100));
    }
    const boxLeft = q1Pct;
    const boxWidth = Math.max(2, q3Pct - q1Pct);

    // Skewness badge
    let skewPill = '';
    const skew = item.skewness;
    if (item.name === 'Loud Cover' || isZeroSpread) {
      skewPill = `<span class="badge badge-muted">Constant</span>`;
    } else if (skew > 0.8) {
      skewPill = `<span class="badge badge-amber" title="Positive (right) skew: longer tail to the right">+${fmt(skew, 2)} (Right)</span>`;
    } else if (skew < -0.8) {
      skewPill = `<span class="badge badge-purple" title="Negative (left) skew: longer tail to the left">${fmt(skew, 2)} (Left)</span>`;
    } else {
      skewPill = `<span class="badge badge-teal" title="Approx. symmetric">${fmt(skew, 2)} (Sym)</span>`;
    }

    const zerosPct = totalRows > 0 ? (item.zero_count / totalRows) * 100 : 0;
    const zerosBadge = item.zero_count > 0 
      ? `<span class="zeros-cell" title="${fmt(item.zero_count, 0)} zero values (${fmt(zerosPct, 1)}%)">${fmt(item.zero_count, 0)} <small>(${fmt(zerosPct, 1)}%)</small></span>` 
      : `<span class="text-muted">0 (0%)</span>`;

    return `
      <tr class="stats-row" data-feature="${escapeHtml(item.name)}">
        <td class="feature-col">
          <div class="feature-title-wrap">
            <span class="feature-dot" style="background-color: ${FEATURE_COLORS[item.name] || PALETTE.teal};"></span>
            <strong>${escapeHtml(item.name)}</strong>
          </div>
          <small class="feature-type">numerical · ${item.unique_count.toLocaleString()} unique</small>
        </td>
        <td class="num-cell tabular">${item.count.toLocaleString()}</td>
        <td class="num-cell tabular font-bold">${fmt(item.mean, 2)}</td>
        <td class="num-cell tabular">${fmt(item.std, 2)}</td>
        <td class="num-cell tabular">${fmt(item.min, 2)}</td>
        <td class="num-cell tabular text-muted">${fmt(item.q1, 2)}</td>
        <td class="num-cell tabular highlight-cell font-bold">${fmt(item.median, 2)}</td>
        <td class="num-cell tabular text-muted">${fmt(item.q3, 2)}</td>
        <td class="num-cell tabular">${fmt(item.max, 2)}</td>
        <td class="num-cell tabular">${fmt(item.iqr, 2)}</td>
        <td class="num-cell">${skewPill}</td>
        <td class="num-cell">${zerosBadge}</td>
        <td class="range-col">
          <div class="range-bar-track" title="Min: ${fmt(item.min, 2)} | Q1: ${fmt(item.q1, 2)} | Med: ${fmt(item.median, 2)} | Q3: ${fmt(item.q3, 2)} | Max: ${fmt(item.max, 2)}">
            <div class="range-bar-iqr" style="left: ${boxLeft}%; width: ${boxWidth}%;"></div>
            <div class="range-bar-median" style="left: ${medPct}%;"></div>
          </div>
          <div class="range-labels">
            <span>${fmt(item.min, 1)}</span>
            <span class="med-label">M: ${fmt(item.median, 1)}</span>
            <span>${fmt(item.max, 1)}</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  byId('stats-table-foot').innerHTML = `
    <span>Showing <strong>${entries.length}</strong> numerical features. Click any row to jump directly to its distribution deep-dive.</span>
  `;

  // Attach jump-to-feature click handler
  tbody.querySelectorAll('.stats-row').forEach(row => {
    row.addEventListener('click', () => {
      const feat = row.dataset.feature;
      if (feat && byId('distribution-feature')) {
        byId('distribution-feature').value = feat;
        drawDistribution();
        if (window.showSection) window.showSection('distributions');
        else { const target = byId('distributions'); if (target) target.scrollIntoView({ behavior: 'smooth' }); }
      }
    });
  });
}

function renderCategoricalStatsTable() {
  const catStats = report.descriptive_statistics.categorical;
  const tbody = byId('categorical-stats-tbody');
  if (!tbody) return;

  const totalRows = report.dataset_overview.row_count;

  tbody.innerHTML = Object.keys(catStats).map(name => {
    const item = catStats[name];
    const missingPct = totalRows > 0 ? ((totalRows - item.non_missing_count) / totalRows) * 100 : 0;
    const modePct = item.categories && item.categories[0] ? item.categories[0].percentage : 0;
    const modeCount = item.categories && item.categories[0] ? item.categories[0].count : 0;

    const topCategories = (item.categories || []).slice(0, 4);
    const topHtml = topCategories.map(cat => `
      <div class="cat-pill-wrap">
        <span class="cat-name" title="${escapeHtml(cat.category)}">${escapeHtml(cat.category)}</span>
        <div class="cat-bar"><div class="cat-bar-fill" style="width: ${Math.min(100, cat.percentage)}%;"></div></div>
        <span class="cat-pct">${fmt(cat.percentage, 1)}%</span>
      </div>
    `).join('');

    return `
      <tr>
        <td class="feature-col">
          <strong>${escapeHtml(name)}</strong>
          <small class="feature-type">categorical string</small>
        </td>
        <td class="num-cell tabular">
          ${item.non_missing_count.toLocaleString()}
          ${missingPct > 0 ? `<br><small class="text-amber">(${fmt(missingPct, 2)}% missing)</small>` : ''}
        </td>
        <td class="num-cell tabular font-bold">${item.unique_count.toLocaleString()}</td>
        <td>
          <span class="badge badge-teal font-bold">${escapeHtml(item.mode || '—')}</span>
        </td>
        <td class="num-cell tabular">${modeCount.toLocaleString()}</td>
        <td class="num-cell tabular font-bold">${fmt(modePct, 1)}%</td>
        <td>
          <div class="cat-breakdown-list">${topHtml}</div>
        </td>
      </tr>
    `;
  }).join('');
}

function exportStatsCsv() {
  const numStats = report.descriptive_statistics.numerical;
  const headers = ['Feature', 'Count', 'Mean', 'Std_Dev', 'Min', '25%_Q1', '50%_Median', '75%_Q3', 'Max', 'IQR', 'Skewness', 'Zero_Count', 'Unique_Count'];
  const rows = [headers.join(',')];

  Object.keys(numStats).forEach(name => {
    const s = numStats[name];
    rows.push([
      `"${name}"`,
      s.count,
      s.mean?.toFixed(4) ?? '',
      s.std?.toFixed(4) ?? '',
      s.min?.toFixed(4) ?? '',
      s.q1?.toFixed(4) ?? '',
      s.median?.toFixed(4) ?? '',
      s.q3?.toFixed(4) ?? '',
      s.max?.toFixed(4) ?? '',
      s.iqr?.toFixed(4) ?? '',
      s.skewness?.toFixed(4) ?? '',
      s.zero_count,
      s.unique_count
    ].join(','));
  });

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', 'weather_history_features_description.csv');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ==========================================
// 3. All Features KDE Gallery & Standardized Overlay
// ==========================================
function renderAllKde() {
  drawAllKdeGrid();
  drawKdeOverlay();
}

function drawAllKdeGrid() {
  const container = byId('kde-grid-container');
  if (!container) return;

  const features = [
    'Temperature (C)',
    'Apparent Temperature (C)',
    'Humidity',
    'Wind Speed (km/h)',
    'Wind Bearing (degrees)',
    'Visibility (km)',
    'Pressure (millibars)',
    'Loud Cover'
  ];

  container.innerHTML = features.map((feat, idx) => {
    const kdeData = report.kde[feat];
    const stats = report.descriptive_statistics.numerical[feat];
    const color = FEATURE_COLORS[feat] || PALETTE.teal;
    const isOk = kdeData?.status === 'ok';
    const skew = stats?.skewness;
    const shapeText = !isOk ? 'A density curve is unavailable because the feature is constant or has too few distinct values.'
      : skew == null ? 'Read the smoothed curve together with the histogram; KDE shape depends on bandwidth.'
      : Math.abs(skew) < 0.5 ? 'The distribution is roughly balanced around its center by skewness.'
      : skew > 0 ? `The distribution has a longer right tail (skewness ${fmt(skew, 2)}).`
      : `The distribution has a longer left tail (skewness ${fmt(skew, 2)}).`;

    return `
      <article class="kde-card panel" id="kde-card-${idx}">
        <div class="kde-card-head">
          <div>
            <h4 class="kde-card-title">${escapeHtml(feat)}</h4>
            <span class="kde-card-sub">${isOk ? `Gaussian KDE · Scott's Rule (${fmt(kdeData.sample_size, 0)} pts)` : 'Singular Covariance'}</span>
          </div>
          <span class="badge ${isOk ? 'badge-teal' : 'badge-amber'}">${isOk ? 'Active KDE' : 'Constant'}</span>
        </div>
        <div class="kde-card-plot" id="kde-plot-${idx}"></div>
        <div class="kde-card-metrics">
          <div class="kde-metric-item">
            <span>MEAN (μ)</span>
            <strong>${fmt(stats?.mean, 2)}</strong>
          </div>
          <div class="kde-metric-item">
            <span>MEDIAN</span>
            <strong>${fmt(stats?.median, 2)}</strong>
          </div>
          <div class="kde-metric-item">
            <span>RANGE [MIN, MAX]</span>
            <strong>[${fmt(stats?.min, 1)}, ${fmt(stats?.max, 1)}]</strong>
          </div>
        </div>
        <p class="chart-interpretation">${escapeHtml(shapeText)}</p>
        <div class="kde-card-foot">
          <button class="btn btn-sm btn-outline deep-dive-btn" data-feature="${escapeHtml(feat)}">
            Deep Dive ↗
          </button>
        </div>
      </article>
    `;
  }).join('');

  // Draw each mini Plotly KDE plot
  features.forEach((feat, idx) => {
    const kdeData = report.kde[feat];
    const color = FEATURE_COLORS[feat] || PALETTE.teal;
    const plotElemId = `kde-plot-${idx}`;

    if (kdeData?.status === 'ok') {
      const trace = {
        type: 'scatter',
        mode: 'lines',
        x: kdeData.x,
        y: kdeData.density,
        line: { color, width: 2.2 },
        fill: 'tozeroy',
        fillcolor: `${color}28`, // 15% opacity hex
        name: feat,
        hovertemplate: `<b>${escapeHtml(feat)}</b><br>Value: %{x:.2f}<br>Density: %{y:.4f}<extra></extra>`
      };

      const miniLayout = {
        ...structuredClone(layoutBase),
        margin: { l: 38, r: 16, t: 12, b: 32 },
        showlegend: false,
        xaxis: {
          ...layoutBase.xaxis,
          tickfont: { size: 9 },
          gridcolor: '#f0f4f2'
        },
        yaxis: {
          ...layoutBase.yaxis,
          tickfont: { size: 9 },
          gridcolor: '#f0f4f2'
        }
      };

      Plotly.react(plotElemId, [trace], miniLayout, { ...PLOT_CONFIG, displayModeBar: false });
    } else {
      // Empty / constant placeholder
      const placeholder = byId(plotElemId);
      if (placeholder) {
        placeholder.innerHTML = `
          <div class="constant-placeholder">
            <span class="constant-icon">∅</span>
            <p><strong>Constant Feature (Value = 0)</strong><br>All 96,453 rows contain identical value. Variance is zero, so Gaussian KDE is undefined.</p>
          </div>
        `;
      }
    }
  });

  // Attach Deep Dive jump buttons
  container.querySelectorAll('.deep-dive-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const feat = btn.dataset.feature;
      if (feat && byId('distribution-feature')) {
        byId('distribution-feature').value = feat;
        drawDistribution();
        if (window.showSection) window.showSection('distributions');
        else { const distSec = byId('distributions'); if (distSec) distSec.scrollIntoView({ behavior: 'smooth' }); }
      }
    });
  });
}

function drawKdeOverlay() {
  const features = Object.keys(report.kde).filter(feat => report.kde[feat].status === 'ok');
  const numStats = report.descriptive_statistics.numerical;

  const traces = features.map(feat => {
    const k = report.kde[feat];
    const s = numStats[feat];
    const color = FEATURE_COLORS[feat] || PALETTE.teal;

    // Standardize x: z = (x - mean) / std
    // Standardize density: f_Z(z) = f_X(x) * std
    const mean = s.mean;
    const std = s.std > 0 ? s.std : 1;

    const z = k.x.map(xVal => (xVal - mean) / std);
    const zDensity = k.density.map(dVal => dVal * std);

    return {
      type: 'scatter',
      mode: 'lines',
      name: feat,
      x: z,
      y: zDensity,
      line: { color, width: 2.2 },
      customdata: k.x,
      hovertemplate: `<b>${escapeHtml(feat)}</b><br>Z-score: %{x:.2f} σ<br>Original: %{customdata:.2f}<br>Normalized Density: %{y:.4f}<extra></extra>`
    };
  });

  const overlayLayout = {
    margin: { l: 56, r: 24, t: 30, b: 55 },
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Standardized Deviations from Mean (Z-Score in Units of σ)', font: { size: 11, color: PALETTE.ink } },
      range: [-4.2, 4.2]
    },
    yaxis: {
      ...layoutBase.yaxis,
      title: { text: 'Standardized Probability Density', font: { size: 11, color: PALETTE.ink } }
    },
    legend: {
      orientation: 'h',
      x: 0,
      y: 1.18,
      font: { size: 10 }
    }
  };

  plot('kde-overlay-chart', traces, overlayLayout);
}

// ==========================================
// 4. Single Distribution Deep Dive
// ==========================================
function drawDistribution() {
  const feature = byId('distribution-feature').value;
  const h = report.distributions.histograms[feature];
  const k = report.kde[feature];
  const color = FEATURE_COLORS[feature] || PALETTE.teal;

  const centers = h.bin_edges.slice(0, -1).map((x, i) => (x + h.bin_edges[i + 1]) / 2);
  const widths = h.bin_edges.slice(0, -1).map((x, i) => h.bin_edges[i + 1] - x);
  const density = h.counts.map((n, i) => n / (h.original_count * widths[i]));

  const traces = [
    {
      type: 'bar',
      x: centers,
      y: density,
      width: widths,
      marker: {
        color: `${color}66`,
        line: { color, width: 1 }
      },
      name: 'Sample Histogram (40 bins)',
      hovertemplate: 'Bin Center: %{x:.3f}<br>Density: %{y:.4f}<extra></extra>'
    }
  ];

  if (k?.status === 'ok') {
    traces.push({
      type: 'scatter',
      mode: 'lines',
      x: k.x,
      y: k.density,
      line: { color: PALETTE.ink, width: 2.8 },
      name: `Gaussian KDE (${k.bandwidth_method || "Scott's rule"})`,
      hovertemplate: 'Value: %{x:.3f}<br>Density: %{y:.4f}<extra></extra>'
    });
  }

  plot('distribution-chart', traces, {
    barmode: 'overlay',
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: feature, font: { size: 11, color: PALETTE.ink } }
    },
    yaxis: {
      ...layoutBase.yaxis,
      title: { text: 'Probability Density', font: { size: 11, color: PALETTE.ink } }
    }
  });
  const stats = report.distributions.numeric_stats?.[feature] || report.descriptive_statistics.numerical[feature];
  const skew = stats?.skewness;
  setChartInterpretation('distribution-chart', `${feature}: ${k?.status === 'ok' ? 'The KDE is available; compare its smoothed shape with the observed histogram.' : (k?.limitation || 'No KDE is available for this feature.')}${skew == null ? '' : ` Skewness is ${fmt(skew, 2)}; positive values indicate a longer right tail and negative values a longer left tail.`}`);

  renderShape(feature);
}

function renderShape(feature) {
  const b = report.distributions.boxplots[feature];
  const k = report.kde[feature];
  const color = FEATURE_COLORS[feature] || PALETTE.teal;

  if (currentShapeMode === 'box') {
    byId('shape-title').textContent = 'Five-Number Quartile Box Plot';
    byId('shape-subtitle').textContent = 'Min, Q1 (25%), Median, Q3 (75%), Max, and 1.5×IQR Outlier Fences';
    byId('box-caption').textContent = b 
      ? `Median: ${fmt(b.median)} · IQR: ${fmt(b.iqr)} · Lower fence: ${fmt(b.whisker_min)} · Upper fence: ${fmt(b.whisker_max)} · ${fmt(b.outlier_count, 0)} records beyond fences`
      : 'Box plot summary not available';

    if (!b || b.median == null) {
      plot('box-chart', [], {});
      return;
    }

    plot('box-chart', [
      {
        type: 'box',
        orientation: 'h',
        q1: [b.q1],
        median: [b.median],
        q3: [b.q3],
        lowerfence: [b.whisker_min],
        upperfence: [b.whisker_max],
        name: feature,
        boxpoints: false,
        fillcolor: `${color}33`,
        line: { color, width: 2 },
        marker: { color },
        hovertemplate: 'Q1: %{q1}<br>Median: %{median}<br>Q3: %{q3}<extra></extra>'
      }
    ], {
      showlegend: false,
      xaxis: {
        ...layoutBase.xaxis,
        title: { text: feature, font: { size: 11, color: PALETTE.ink } }
      },
      yaxis: {
        ...layoutBase.yaxis,
        showticklabels: false,
        showgrid: false
      }
    });
    return;
  }

  // Violin / Mirrored Density Silhouette
  byId('shape-title').textContent = 'Density Silhouette (Violin Profile)';
  byId('shape-subtitle').textContent = "Full kernel density mirrored horizontally to illustrate profile width";
  byId('box-caption').textContent = k?.status === 'ok'
    ? `Scott's Rule Bandwidth · ${fmt(k.sample_size, 0)} evaluation points`
    : (k?.limitation || 'Density curve unavailable');

  if (!k || k.status !== 'ok') {
    plot('box-chart', [], {});
    return;
  }

  const x = [...k.density, ...k.density.slice().reverse().map(v => -v)];
  const y = [...k.x, ...k.x.slice().reverse()];

  plot('box-chart', [
    {
      type: 'scatter',
      mode: 'lines',
      x,
      y,
      fill: 'toself',
      fillcolor: `${color}38`,
      line: { color, width: 2 },
      hovertemplate: 'Coordinate: %{y:.3f}<br>Density: %{x:.4f}<extra></extra>',
      name: feature
    }
  ], {
    showlegend: false,
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Mirrored Density Silhouette', font: { size: 10, color: PALETTE.muted } },
      zeroline: true,
      zerolinecolor: PALETTE.border
    },
    yaxis: {
      ...layoutBase.yaxis,
      title: { text: feature, font: { size: 11, color: PALETTE.ink } }
    }
  });
}

function drawCategory() {
  const feat = byId('category-feature').value;
  const d = report.distributions.categorical_bar_charts[feat];
  if (!d) return;

  const rows = d.chart_categories.slice(0, 18).reverse();

  plot('category-chart', [
    {
      type: 'bar',
      orientation: 'h',
      x: rows.map(r => r.count),
      y: rows.map(r => r.category),
      marker: {
        color: rows.map((_, i) => `rgba(37, 125, 112, ${0.45 + (i * 0.03)})`),
        cornerradius: 4
      },
      customdata: rows.map(r => r.percentage),
      hovertemplate: '<b>%{y}</b><br>%{x:,} observations (%{customdata:.2f}%)<extra></extra>'
    }
  ], {
    showlegend: false,
    margin: { l: 155, r: 24, t: 15, b: 45 },
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Record Count', font: { size: 10, color: PALETTE.ink } }
    },
    yaxis: {
      ...layoutBase.yaxis,
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true,
      tickfont: { size: 10, color: PALETTE.ink }
    }
  });
}

function drawMissing() {
  const d = report.missing_data.columns.slice().sort((a, b) => a.missing_percentage - b.missing_percentage);

  plot('missing-chart', [
    {
      type: 'bar',
      orientation: 'h',
      x: d.map(x => x.missing_percentage),
      y: d.map(x => x.column),
      marker: {
        color: d.map(x => x.missing_percentage > 0 ? PALETTE.amber : '#c8ded7'),
        cornerradius: 4
      },
      customdata: d.map(x => x.missing_count),
      hovertemplate: '<b>%{y}</b><br>%{x:.3f}% missing (%{customdata:,} cells)<extra></extra>'
    }
  ], {
    showlegend: false,
    margin: { l: 165, r: 24, t: 15, b: 45 },
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Missing Share (%)', font: { size: 10, color: PALETTE.ink } },
      range: [0, Math.max(1, Math.max(...d.map(x => x.missing_percentage)) * 1.25)]
    },
    yaxis: {
      ...layoutBase.yaxis,
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true,
      tickfont: { size: 10, color: PALETTE.ink }
    }
  });
}

function drawMissingMatrix() {
  const m = report.missing_data.matrix;
  byId('missing-matrix-tag').textContent = `${fmt(m.exported_row_count, 0)} / ${fmt(m.original_row_count, 0)} DETERMINISTIC ROW SAMPLE`;

  plot('missing-matrix-chart', [
    {
      type: 'heatmap',
      z: m.values,
      x: m.columns,
      y: m.row_indices,
      zmin: 0,
      zmax: 1,
      colorscale: [
        [0, '#e3f3ec'],
        [1, '#e59d3b']
      ],
      showscale: true,
      colorbar: {
        title: { text: 'Status', font: { size: 9, color: PALETTE.ink } },
        tickvals: [0, 1],
        ticktext: ['Present', 'Missing'],
        thickness: 10,
        len: 0.8,
        tickfont: { size: 9 }
      },
      hovertemplate: 'Row index %{y}<br>Field: %{x}<br>Status: %{z:.0f}<extra></extra>'
    }
  ], {
    showlegend: false,
    margin: { l: 60, r: 80, t: 10, b: 90 },
    xaxis: {
      ...layoutBase.xaxis,
      tickangle: -30,
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true
    },
    yaxis: {
      ...layoutBase.yaxis,
      title: { text: 'Sampled Row Index', font: { size: 10, color: PALETTE.muted } },
      gridcolor: 'rgba(0,0,0,0)',
      nticks: 6
    }
  });
}

// ==========================================
// 5. Correlation Matrices
// ==========================================
function drawCorrelation(type = 'pearson') {
  const data = report.correlation_analysis[type];
  const z = data.matrix;
  byId('corr-title').textContent = `${type[0].toUpperCase() + type.slice(1)} Correlation Matrix`;

  const colorscale = [
    [0, '#c7533f'],
    [0.5, '#f6f8f7'],
    [1, '#257d70']
  ];

  plot('correlation-chart', [
    {
      type: 'heatmap',
      z,
      x: data.features,
      y: data.features,
      zmin: -1,
      zmax: 1,
      colorscale,
      showscale: true,
      colorbar: {
        title: { text: 'Coefficient (r)', font: { size: 10, color: PALETTE.ink } },
        thickness: 12,
        len: 0.85,
        tickfont: { size: 9 }
      },
      hovertemplate: '<b>%{y}</b> × <b>%{x}</b><br>Correlation: %{z:.3f}<extra></extra>',
      text: z.map(row => row.map(x => x == null ? '—' : Number(x).toFixed(2))),
      texttemplate: '%{text}',
      textfont: { size: 10, color: '#163834' }
    }
  ], {
    showlegend: false,
    margin: { l: 175, r: 60, t: 10, b: 110 },
    xaxis: {
      ...layoutBase.xaxis,
      side: 'bottom',
      tickangle: -35,
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true
    },
    yaxis: {
      ...layoutBase.yaxis,
      autorange: 'reversed',
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true
    }
  });

  const pos = report.correlation_analysis.strongest_positive;
  const neg = report.correlation_analysis.strongest_negative;

  byId('target-correlation').innerHTML = `
    <span class="insight-label">Key Target Associations with Temperature (C):</span>
    <span class="insight-pill insight-pos">↑ Strongest Positive: <strong>${escapeHtml(pos?.feature || '—')}</strong> (r = ${fmt(pos?.pearson, 3)})</span>
    <span class="insight-pill insight-neg">↓ Strongest Negative: <strong>${escapeHtml(neg?.feature || '—')}</strong> (r = ${fmt(neg?.pearson, 3)})</span>
  `;
}

// ==========================================
// 6. Data Quality, Hampel Outliers & Mahalanobis
// ==========================================
function drawHampel() {
  const col = byId('hampel-feature').value;
  const d = report.noise_detection.chart_data[col];
  const meta = report.noise_detection.features[col];
  if (!d) {
    plot('hampel-chart', [], {});
    return;
  }

  const x = d.timestamp.map((v, i) => v || d.row_index[i]);
  const flagX = [], flagY = [];
  d.flagged.forEach((f, i) => {
    if (f) {
      flagX.push(x[i]);
      flagY.push(d.observed[i]);
    }
  });

  const traces = [
    {
      type: 'scattergl',
      mode: 'lines',
      x,
      y: d.observed,
      name: 'Observed Value',
      line: { color: 'rgba(37, 125, 112, 0.65)', width: 1.2 },
      connectgaps: false,
      hovertemplate: 'Time: %{x}<br>Observed: %{y:.2f}<extra></extra>'
    },
    {
      type: 'scattergl',
      mode: 'lines',
      x,
      y: d.rolling_median,
      name: '11-pt Rolling Median',
      line: { color: PALETTE.blue, width: 1.8 },
      connectgaps: false,
      hovertemplate: 'Time: %{x}<br>Median: %{y:.2f}<extra></extra>'
    },
    {
      type: 'scattergl',
      mode: 'markers',
      x: flagX,
      y: flagY,
      name: `Hampel Outliers (${fmt(meta.flag_count, 0)})`,
      marker: {
        color: PALETTE.coral,
        size: 6,
        opacity: 0.85,
        line: { color: '#ffffff', width: 0.8 }
      },
      hovertemplate: '<b>Flagged Outlier</b><br>Time: %{x}<br>Value: %{y:.2f}<extra></extra>'
    }
  ];

  plot('hampel-chart', traces, {
    margin: { l: 55, r: 24, t: 20, b: 60 },
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Chronological Timeline', font: { size: 10, color: PALETTE.muted } },
      tickangle: -20
    },
    yaxis: {
      ...layoutBase.yaxis,
      title: { text: col, font: { size: 11, color: PALETTE.ink } }
    }
  });

  byId('hampel-caption').textContent = `${fmt(meta.flag_count, 0)} outliers detected out of ${fmt(meta.valid_count, 0)} observations (${fmt(meta.flag_percentage, 2)}%). Displaying representative 2,000 timeline points; all flagged points are strictly preserved.`;

  renderNoiseTable();
}

function renderNoiseTable() {
  const col = byId('hampel-feature').value;
  const rows = report.noise_detection.features[col]?.flagged_observations || [];
  const query = byId('noise-search').value.trim().toLowerCase();

  const filtered = rows.filter(r => `${r.timestamp} ${r.value} ${r.row_index}`.toLowerCase().includes(query));
  const page = filtered.slice(noisePage * FLAG_PAGE_SIZE, (noisePage + 1) * FLAG_PAGE_SIZE);

  byId('noise-table').innerHTML = page.map(r => `
    <tr>
      <td>${escapeHtml(r.timestamp || '—')}</td>
      <td class="num-cell tabular font-bold text-coral">${fmt(r.value, 3)}</td>
      <td class="num-cell tabular">${fmt(r.rolling_median, 3)}</td>
      <td class="num-cell tabular">${fmt(r.absolute_deviation, 3)}</td>
      <td class="num-cell tabular text-muted">${fmt(r.row_index, 0)}</td>
    </tr>
  `).join('');

  byId('noise-table-sub').textContent = `${fmt(rows.length, 0)} flagged points for ${escapeHtml(col)}`;
  byId('noise-table-foot').textContent = `Page ${filtered.length ? noisePage + 1 : 0} of ${Math.ceil(filtered.length / FLAG_PAGE_SIZE)} · displaying ${page.length.toLocaleString()} of ${filtered.length.toLocaleString()} matching rows`;
  byId('noise-prev').disabled = noisePage === 0;
  byId('noise-next').disabled = (noisePage + 1) * FLAG_PAGE_SIZE >= filtered.length;
}

function drawAnomalies() {
  const a = report.anomaly_detection;
  const c = a.chart_data.histogram;
  const edges = c.bin_edges;
  const centers = edges.slice(0, -1).map((v, i) => (v + edges[i + 1]) / 2);
  const widths = edges.slice(0, -1).map((v, i) => edges[i + 1] - v);

  plot('anomaly-chart', [
    {
      type: 'bar',
      x: centers,
      y: c.counts,
      width: widths,
      marker: { color: 'rgba(59, 120, 171, 0.55)' },
      name: 'Observations',
      hovertemplate: 'Squared Distance D²: %{x:.2f}<br>Count: %{y:,}<extra></extra>'
    }
  ], {
    showlegend: false,
    shapes: [
      {
        type: 'line',
        x0: a.threshold,
        x1: a.threshold,
        y0: 0,
        y1: 1,
        yref: 'paper',
        line: { color: PALETTE.coral, width: 2.2, dash: 'dash' }
      }
    ],
    annotations: [
      {
        x: a.threshold,
        y: 1,
        yref: 'paper',
        text: `99% Cutoff (D² = ${fmt(a.threshold, 2)})`,
        showarrow: false,
        xanchor: 'left',
        font: { size: 10, color: PALETTE.coral, weight: 'bold' }
      }
    ],
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Squared Mahalanobis Distance (D²)', font: { size: 11, color: PALETTE.ink } }
    },
    yaxis: {
      ...layoutBase.yaxis,
      title: { text: 'Observation Frequency', font: { size: 11, color: PALETTE.ink } }
    }
  });

  byId('anomaly-caption').textContent = `${fmt(a.flag_count, 0)} multivariate anomalies flagged (${fmt(a.flag_percentage, 2)}%) among ${fmt(a.complete_case_count, 0)} complete cases (${a.degrees_of_freedom} degrees of freedom; threshold D² = ${fmt(a.threshold, 2)}).`;

  renderAnomalyTable();
}

function renderAnomalyTable() {
  const rows = report.anomaly_detection.flagged_observations || [];
  const query = byId('anomaly-search').value.trim().toLowerCase();

  const filtered = rows.filter(r => `${r.timestamp} ${r.row_index}`.toLowerCase().includes(query));
  const page = filtered.slice(anomalyPage * FLAG_PAGE_SIZE, (anomalyPage + 1) * FLAG_PAGE_SIZE);

  byId('anomaly-table').innerHTML = page.map(r => `
    <tr>
      <td>${escapeHtml(r.timestamp || '—')}</td>
      <td class="num-cell tabular font-bold">${fmt(r.distance, 3)}</td>
      <td class="num-cell tabular text-coral">${fmt(r.squared_distance, 3)}</td>
      <td class="num-cell tabular text-muted">${fmt(r.row_index, 0)}</td>
    </tr>
  `).join('');

  byId('anomaly-table-sub').textContent = `${fmt(rows.length, 0)} flagged multivariate anomalies`;
  byId('anomaly-table-foot').textContent = `Page ${filtered.length ? anomalyPage + 1 : 0} of ${Math.ceil(filtered.length / FLAG_PAGE_SIZE)} · displaying ${page.length.toLocaleString()} of ${filtered.length.toLocaleString()} matching records`;
  byId('anomaly-prev').disabled = anomalyPage === 0;
  byId('anomaly-next').disabled = (anomalyPage + 1) * FLAG_PAGE_SIZE >= filtered.length;
}

// ==========================================
// 7. Predictive Models & Importance
// ==========================================
function cleanFeatureLabel(raw) {
  let name = String(raw || '').replace(/^numeric__/, '').replace(/^categorical__/, '');
  if (name === 'date_day_of_year_cos') return 'Day of Year (Annual Cosine Cycle)';
  if (name === 'date_day_of_year_sin') return 'Day of Year (Annual Sine Cycle)';
  if (name === 'date_hour_cos') return 'Hour of Day (Diurnal Cosine Cycle)';
  if (name === 'date_hour_sin') return 'Hour of Day (Diurnal Sine Cycle)';
  if (name === 'date_month') return 'Calendar Month (Seasonality)';
  if (name.startsWith('Precip Type_')) return `Precipitation: ${name.replace('Precip Type_', '').toUpperCase()}`;
  if (name.startsWith('Summary_')) return `Sky: ${name.replace('Summary_', '')}`;
  return name;
}

function getFeatureCategory(raw) {
  const str = String(raw || '');
  if (str.includes('date_day_of_year') || str.includes('date_month')) return '<span class="badge badge-purple">Engineered · annual calendar</span>';
  if (str.includes('date_hour')) return '<span class="badge badge-blue">Engineered · hour cycle</span>';
  if (str.includes('Precip Type')) return '<span class="badge badge-coral">Precipitation</span>';
  if (str.includes('Summary')) return '<span class="badge badge-amber">Sky Condition</span>';
  return '<span class="badge badge-teal">Atmospheric</span>';
}

function featureProvenance(raw) {
  const str = String(raw || '').replace(/^numeric__/, '').replace(/^categorical__/, '');
  if (str === 'date_day_of_year_cos') return 'Engineered from Formatted Date · annual cosine component';
  if (str === 'date_day_of_year_sin') return 'Engineered from Formatted Date · annual sine component';
  if (str === 'date_hour_cos') return 'Engineered from Formatted Date · daily cosine component';
  if (str === 'date_hour_sin') return 'Engineered from Formatted Date · daily sine component';
  if (str === 'date_month') return 'Engineered from Formatted Date · calendar month';
  return 'Source column or one-hot encoded category';
}

function drawModel() {
  const key = byId('model-experiment').value;
  const e = report.feature_importance.experiments[key];
  if (!e || e.status !== 'ok') {
    showError(`Model results unavailable: ${e?.reason || 'No experiment data'}`);
    return;
  }

  const isWithoutApparent = key.includes('exclude') || key.startsWith('B_');
  if (byId('fi-table-title')) {
    byId('fi-table-title').textContent = isWithoutApparent
      ? 'Feature Importance Excluding Derived Apparent Temperature'
      : 'Feature Importance Leaderboard (With Apparent Temperature Baseline)';
    byId('fi-table-sub').textContent = isWithoutApparent
      ? 'Target: Temperature (C) · Random Forest on predictors excluding derived Apparent Temperature; chronological holdout plus expanding-window validation.'
      : 'Target: Temperature (C) · Includes derived Apparent Temperature as a separate, easier comparison.';
  }

  const m = e.metrics;
  byId('model-metrics').innerHTML = [
    ['MEAN ABSOLUTE ERROR (MAE)', `${fmt(m.mae, 3)} °C`, 'lower is better'],
    ['ROOT MEAN SQUARED ERROR (RMSE)', `${fmt(m.rmse, 3)} °C`, 'lower is better'],
    ['R² DETERMINATION COEFFICIENT', `${fmt(m.r2, 4)} (${fmt(m.r2 * 100, 1)}% variance explained)`, 'higher is better']
  ].map(([lbl, val, sub]) => `
    <div class="model-metric-card">
      <span class="model-metric-label">${lbl}</span>
      <strong class="model-metric-val">${val}</strong>
      <small class="model-metric-sub">${sub}</small>
    </div>
  `).join('');

  const rolling = report.feature_importance.rolling_origin_validation;
  const rollingCard = byId('rolling-validation-card');
  if (rollingCard) {
    rollingCard.hidden = !(key.startsWith('B_') && rolling?.status === 'ok');
    if (!rollingCard.hidden) {
      const s = rolling.summary;
      byId('rolling-validation-text').textContent = `Expanding-window validation across ${rolling.folds.length} earlier chronological windows. Random Forest without apparent temperature: mean MAE ${fmt(s.mae, 3)} °C, RMSE ${fmt(s.rmse, 3)} °C, R² ${fmt(s.r2, 4)}. Month × hour baseline on those same windows: MAE ${fmt(s.seasonal_baseline_mae, 3)} °C, RMSE ${fmt(s.seasonal_baseline_rmse, 3)} °C, R² ${fmt(s.seasonal_baseline_r2, 4)}. Lower errors and higher R² are better. ${rolling.limitation}`;
    }
  }
  const seasonal = report.feature_importance.seasonal_baseline;
  if (seasonal?.metrics) {
    const m = seasonal.metrics;
    setChartInterpretation('compare-mae', `Lower is better. Calendar month × hour baseline: ${fmt(m.mae, 3)} °C MAE. The no-apparent-temperature model improves on the baseline if its bar is lower.`);
    setChartInterpretation('compare-rmse', `Lower is better. Calendar month × hour baseline: ${fmt(m.rmse, 3)} °C RMSE. RMSE penalizes large errors more than MAE does.`);
    setChartInterpretation('compare-r2', `Higher is better. Calendar month × hour baseline R²: ${fmt(m.r2, 4)}. R² can be negative when predictions are worse than using the test-set mean.`);
  }

  // Cleaned impurity importance
  const imp = e.impurity_importance.slice(0, 16).reverse();
  plot('impurity-chart', [
    {
      type: 'bar',
      orientation: 'h',
      x: imp.map(x => x.importance),
      y: imp.map(x => cleanFeatureLabel(x.feature)),
      marker: {
        color: imp.map((_, i) => `rgba(37, 125, 112, ${0.45 + (i * 0.035)})`),
        cornerradius: 4
      },
      customdata: imp.map(x => x.importance * 100),
      hovertemplate: '<b>%{y}</b><br>Impurity Share: %{customdata:.2f}% (Score: %{x:.4f})<extra></extra>'
    }
  ], {
    showlegend: false,
    margin: { l: 230, r: 24, t: 15, b: 40 },
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Impurity Score (MDI / Relative Share)', font: { size: 10, color: PALETTE.ink } }
    },
    yaxis: {
      ...layoutBase.yaxis,
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true,
      tickfont: { size: 10, color: PALETTE.ink }
    }
  });

  // Cleaned permutation importance
  const per = e.permutation_importance.slice(0, 16).reverse();
  plot('permutation-chart', [
    {
      type: 'bar',
      orientation: 'h',
      x: per.map(x => x.importance),
      y: per.map(x => cleanFeatureLabel(x.feature)),
      error_x: {
        type: 'data',
        array: per.map(x => x.standard_deviation || 0),
        visible: true,
        color: '#658a82',
        thickness: 1.4,
        width: 3
      },
      marker: {
        color: PALETTE.blue,
        cornerradius: 4
      },
      hovertemplate: '<b>%{y}</b><br>Held-out R² Decrease: %{x:.4f} (±%{error_x.array:.4f})<extra></extra>'
    }
  ], {
    showlegend: false,
    margin: { l: 230, r: 24, t: 15, b: 40 },
    xaxis: {
      ...layoutBase.xaxis,
      title: { text: 'Held-out R² Score Decrease (Permutation Impact)', font: { size: 10, color: PALETTE.ink } }
    },
    yaxis: {
      ...layoutBase.yaxis,
      gridcolor: 'rgba(0,0,0,0)',
      automargin: true,
      tickfont: { size: 10, color: PALETTE.ink }
    }
  });

  // Populate Leaderboard Table
  const tbody = byId('model-fi-tbody');
  if (tbody) {
    const permMap = new Map();
    (e.permutation_importance || []).forEach(p => permMap.set(p.feature, p));

    const topFeatures = e.impurity_importance.slice(0, 20);
    const maxImp = Math.max(...topFeatures.map(f => f.importance), 0.001);

    tbody.innerHTML = topFeatures.map((item, idx) => {
      const permItem = permMap.get(item.feature);
      const impPct = item.importance * 100;
      const barWidth = Math.max(3, (item.importance / maxImp) * 100);
      const permScore = permItem ? fmt(permItem.importance, 4) : '—';
      const permStd = permItem?.standard_deviation != null ? `±${fmt(permItem.standard_deviation, 4)}` : '—';

      return `
        <tr>
          <td class="tabular font-bold">${idx + 1}</td>
          <td>
            <strong>${escapeHtml(cleanFeatureLabel(item.feature))}</strong>
            <small class="feature-type" title="${escapeHtml(featureProvenance(item.feature))}">${escapeHtml(featureProvenance(item.feature))}</small>
          </td>
          <td>${getFeatureCategory(item.feature)}</td>
          <td class="num-cell tabular font-bold">${fmt(impPct, 2)}%</td>
          <td>
            <div class="cat-bar" style="height: 8px;">
              <div class="cat-bar-fill" style="width: ${barWidth}%; background: ${idx < 3 ? 'var(--teal)' : 'var(--blue)'};"></div>
            </div>
          </td>
          <td class="num-cell tabular font-bold text-coral">${permScore}</td>
          <td class="num-cell tabular text-muted">${permStd}</td>
        </tr>
      `;
    }).join('');
    const topPermutation = (e.permutation_importance || [])[0];
    if (topPermutation) {
      setChartInterpretation('model-fi-table', `Top held-out permutation feature: ${cleanFeatureLabel(topPermutation.feature)} (R² decrease ${fmt(topPermutation.importance, 4)} ± ${fmt(topPermutation.standard_deviation, 4)} across five shuffles). This is predictive usefulness for this split, not a causal effect. ${featureProvenance(topPermutation.feature)}.`);
    }
  }

  drawModelComparison();
}

function drawModelComparison() {
  const labels = ['No Apparent Temp', 'With Apparent Temp', 'Month × Hour Baseline'];
  const names = ['B_exclude_apparent_temperature', 'A_include_apparent_temperature', 'seasonal_climatology'];
  const metrics = report.feature_importance.metric_comparison;

  for (const metric of ['mae', 'rmse', 'r2']) {
    const activeNames = names.filter(n => metrics[metric]?.[n] != null);
    const activeLabels = activeNames.map(n => labels[names.indexOf(n)]);
    const values = activeNames.map(n => metrics[metric][n]);
    plot(`compare-${metric}`, [
      {
        type: 'bar',
        x: activeLabels,
        y: values,
        marker: {
          color: activeNames.map(n => n === 'seasonal_climatology' ? PALETTE.amber : n.startsWith('A_') ? PALETTE.blue : PALETTE.teal),
          cornerradius: 5
        },
        text: values.map(v => fmt(v, metric === 'r2' ? 4 : 3)),
        textposition: 'outside',
        cliponaxis: false,
        hovertemplate: '<b>%{x}</b><br>' + metric.toUpperCase() + ': %{y:.5f}<extra></extra>'
      }
    ], {
      showlegend: false,
      margin: { l: 36, r: 20, t: 25, b: 55 },
      xaxis: {
        ...layoutBase.xaxis,
        gridcolor: 'rgba(0,0,0,0)',
        tickangle: -15,
        tickfont: { size: 9 }
      },
      yaxis: {
        ...layoutBase.yaxis,
        gridcolor: PALETTE.grid,
        tickfont: { size: 9 },
        range: metric === 'r2' ? undefined : [0, Math.max(...values) * 1.25]
      }
    });
  }
}

// ==========================================
// 8. Event Listeners & UI Controls
// ==========================================
function setupControls() {
  // Dropdown populations
  optionList(byId('distribution-feature'), Object.keys(report.distributions.histograms));
  optionList(byId('category-feature'), Object.keys(report.distributions.categorical_bar_charts));

  const hampelKeys = Object.keys(report.noise_detection.features).filter(k => report.noise_detection.features[k].status === 'ok');
  optionList(byId('hampel-feature'), hampelKeys);

  // Default to the experiment excluding the target-derived Apparent Temperature predictor.
  const expKeys = Object.keys(report.feature_importance.experiments);
  const orderedExpKeys = expKeys.sort((a, b) => b.localeCompare(a)); // Puts 'B_' before 'A_'
  optionList(
    byId('model-experiment'),
    orderedExpKeys,
    v => v.startsWith('B_') 
      ? '★ Random Forest excluding derived Apparent Temperature'
      : 'Baseline: Random Forest with Apparent Temperature Included'
  );

  // Change listeners
  byId('distribution-feature').addEventListener('change', drawDistribution);
  byId('category-feature').addEventListener('change', drawCategory);
  byId('hampel-feature').addEventListener('change', drawHampel);
  byId('model-experiment').addEventListener('change', drawModel);

  // Search filters
  byId('stats-search').addEventListener('input', renderNumericalStatsTable);
  byId('noise-search').addEventListener('input', () => { noisePage = 0; renderNoiseTable(); });
  byId('anomaly-search').addEventListener('input', () => { anomalyPage = 0; renderAnomalyTable(); });
  byId('noise-prev').addEventListener('click', () => { noisePage = Math.max(0, noisePage - 1); renderNoiseTable(); });
  byId('noise-next').addEventListener('click', () => { noisePage += 1; renderNoiseTable(); });
  byId('anomaly-prev').addEventListener('click', () => { anomalyPage = Math.max(0, anomalyPage - 1); renderAnomalyTable(); });
  byId('anomaly-next').addEventListener('click', () => { anomalyPage += 1; renderAnomalyTable(); });

  // Export CSV
  byId('export-stats-csv').addEventListener('click', exportStatsCsv);

  // Data description table sorting
  document.querySelectorAll('#numerical-stats-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (currentStatsSort.column === col) {
        currentStatsSort.direction = currentStatsSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentStatsSort.column = col;
        currentStatsSort.direction = 'asc';
      }
      document.querySelectorAll('#numerical-stats-table th.sortable').forEach(h => {
        h.classList.remove('sorted-asc', 'sorted-desc');
      });
      th.classList.add(currentStatsSort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
      renderNumericalStatsTable();
    });
  });

  // Stats view segmented toggle (numerical vs categorical)
  document.querySelectorAll('[data-stats-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-stats-view]').forEach(b => b.classList.toggle('active', b === btn));
      const mode = btn.dataset.statsView;
      currentStatsView = mode;
      byId('numerical-stats-panel').style.display = mode === 'numerical' ? 'block' : 'none';
      byId('categorical-stats-panel').style.display = mode === 'categorical' ? 'block' : 'none';
    });
  });

  // KDE view toggle (gallery grid vs standardized overlay)
  document.querySelectorAll('[data-kde-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-kde-mode]').forEach(b => b.classList.toggle('active', b === btn));
      const mode = btn.dataset.kdeMode;
      currentKdeView = mode;
      byId('kde-grid-container').style.display = mode === 'grid' ? 'grid' : 'none';
      byId('kde-overlay-container').style.display = mode === 'overlay' ? 'block' : 'none';
      if (mode === 'overlay') {
        drawKdeOverlay();
      }
    });
  });

  // Correlation type toggle
  document.querySelectorAll('[data-correlation]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-correlation]').forEach(b => b.classList.toggle('active', b === btn));
      drawCorrelation(btn.dataset.correlation);
    });
  });

  // Box vs Violin toggle
  document.querySelectorAll('[data-shape]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentShapeMode = btn.dataset.shape;
      document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('active', b === btn));
      renderShape(byId('distribution-feature').value);
    });
  });

  // Page navigation and the active link are handled by layout.js
}

// ==========================================
// 8.5. Meteorological Health Gauge
// ==========================================
function drawHealthGauge() {
  const container = byId('health-gauge-plot');
  if (!container) return;

  const zeroPressure = report.descriptive_statistics.numerical['Pressure (millibars)']?.zero_count || 0;
  const pressureCount = report.descriptive_statistics.numerical['Pressure (millibars)']?.count || 0;
  const values = [Math.max(0, pressureCount - zeroPressure), zeroPressure];
  const labels = ['Nonzero pressure readings (not independently validated)', 'Zero pressure readings (review source encoding)'];
  const colors = [PALETTE.teal, PALETTE.amber];

  plot('health-gauge-plot', [
    {
      type: 'pie',
      values,
      labels,
      hole: 0.72,
      marker: { colors },
      textinfo: 'none',
      sort: false,
      hovertemplate: '<b>%{label}</b><br>%{value:,} records (%{percent})<extra></extra>'
    }
  ], {
    showlegend: false,
    margin: { l: 10, r: 10, t: 10, b: 10 },
    annotations: [
      {
        text: `<span style="font-size:24px;font-weight:800;color:#183330;font-family:Manrope,sans-serif;">${zeroPressure.toLocaleString()}</span><br><span style="font-size:9px;font-weight:700;color:#677b78;letter-spacing:1px;">ZERO VALUES</span>`,
        showarrow: false,
        font: { size: 14 }
      }
    ]
  });
}

// ==========================================
// 9. Initial Load Routine
// ==========================================
async function load() {
  const errBox = byId('load-error');
  if (errBox) errBox.hidden = true;

  try {
    const response = await fetch('/api/report', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch the EDA report JSON.');
    }
    report = data;

    initOverview();
    renderInterpretationGuides();
    renderTemporalAnalysis();
    setupControls();
    renderDataDescription();
    drawHealthGauge();
    renderAllKde();
    drawDistribution();
    drawCategory();
    drawMissing();
    drawMissingMatrix();
    drawCorrelation();
    drawHampel();
    drawAnomalies();
    drawModel();

  } catch (err) {
    showError(err.message);
  }
}

byId('refresh').addEventListener('click', load);
load();
