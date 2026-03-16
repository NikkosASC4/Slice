/* ─── Constants ─────────────────────────────────────────── */
const COLORS = {
  Food:          '#c8f060',
  Transport:     '#60c8f0',
  Shopping:      '#f060c8',
  Entertainment: '#f0b060',
  Health:        '#7060f0',
  Other:         '#60f0b0',
};
const REMAINING_COLOR = '#2a2b2e';

/* ─── State ─────────────────────────────────────────────── */
let entries = JSON.parse(localStorage.getItem('slice_entries') || '[]');
let budgets = JSON.parse(localStorage.getItem('slice_budgets') || '{}');
let period  = 'daily';
let chart   = null;

/* ─── Persistence ───────────────────────────────────────── */
function save() {
  localStorage.setItem('slice_entries', JSON.stringify(entries));
  localStorage.setItem('slice_budgets', JSON.stringify(budgets));
}

/* ─── Period ────────────────────────────────────────────── */
function setPeriod(p) {
  period = p;
  document.querySelectorAll('#period-tabs button').forEach((btn, i) => {
    btn.classList.toggle('active', ['daily', 'weekly', 'monthly'][i] === p);
  });
  render();
}

/* ─── Filtering ─────────────────────────────────────────── */
function getFiltered() {
  const now = new Date();
  return entries.filter(e => {
    const d = new Date(e.date);
    if (period === 'daily') {
      return d.toDateString() === now.toDateString();
    }
    if (period === 'weekly') {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      return d >= startOfWeek;
    }
    // monthly
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
}

function groupByCategory(list) {
  return list.reduce((map, e) => {
    map[e.category] = (map[e.category] || 0) + e.amount;
    return map;
  }, {});
}

/* ─── Formatting ────────────────────────────────────────── */
function fmt(n) {
  return '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ─── Render ────────────────────────────────────────────── */
function render() {
  const filtered    = getFiltered();
  const grouped     = groupByCategory(filtered);
  const cats        = Object.keys(grouped);
  const totalSpent  = cats.reduce((s, c) => s + grouped[c], 0);
  const budget      = budgets[period] || null;
  const remaining   = budget !== null ? budget - totalSpent : null;
  const isOver      = remaining !== null && remaining < 0;
  const pct         = budget ? Math.min((totalSpent / budget) * 100, 100) : 0;

  const periodLabels = { daily: 'Today', weekly: 'This week', monthly: 'This month' };
  document.getElementById('period-label').textContent     = periodLabels[period];
  document.getElementById('entries-heading').textContent  = periodLabels[period] + "'s entries";

  renderBudgetBar(totalSpent, budget, remaining, isOver, pct);
  renderChart(cats, grouped, totalSpent, budget, remaining, isOver);
  renderEntries(filtered);
}

/* ─── Budget Bar ────────────────────────────────────────── */
function renderBudgetBar(totalSpent, budget, remaining, isOver, pct) {
  const spentEl    = document.getElementById('spent-display');
  const remEl      = document.getElementById('remaining-display');
  const remLabel   = document.getElementById('remaining-label');
  const fillEl     = document.getElementById('progress-fill');

  spentEl.textContent = fmt(totalSpent);

  if (budget !== null) {
    remEl.textContent   = isOver ? '–' + fmt(remaining) : fmt(remaining);
    remEl.className     = 'budget-remaining' + (isOver ? ' over' : '');
    remLabel.textContent = isOver ? 'over budget' : 'remaining of ' + fmt(budget);
    fillEl.style.width  = pct + '%';
    fillEl.className    = 'progress-fill' + (isOver ? ' over' : '');
  } else {
    remEl.textContent    = '—';
    remEl.className      = 'budget-remaining';
    remLabel.textContent = 'set a budget';
    fillEl.style.width   = '0%';
    fillEl.className     = 'progress-fill';
  }
}

/* ─── Chart ─────────────────────────────────────────────── */
function renderChart(cats, grouped, totalSpent, budget, remaining, isOver) {
  const noBudgetMsg = document.getElementById('no-budget-msg');
  const pieCanvas   = document.getElementById('pie');
  const center      = document.getElementById('chart-center');
  const legend      = document.getElementById('legend');
  const totalAmtEl  = document.getElementById('total-amt');
  const budgetOfEl  = document.getElementById('budget-of');

  if (budget === null) {
    noBudgetMsg.style.display = 'flex';
    pieCanvas.style.display   = 'none';
    center.style.display      = 'none';
    if (chart) { chart.destroy(); chart = null; }
    legend.innerHTML = '';
    return;
  }

  noBudgetMsg.style.display = 'none';
  pieCanvas.style.display   = 'block';
  center.style.display      = 'flex';

  totalAmtEl.innerHTML = fmt(totalSpent) +
    '<br><span style="font-size:12px;color:var(--muted);font-family:\'DM Sans\',sans-serif;font-weight:400;">spent</span>';
  budgetOfEl.textContent = 'of ' + fmt(budget);

  // Build slices: one per category, plus a "Remaining" slice if under budget
  const chartCats   = [...cats];
  const chartData   = cats.map(c => grouped[c]);
  const chartColors = cats.map(c => COLORS[c] || '#aaa');

  if (!isOver) {
    chartCats.push('Remaining');
    chartData.push(remaining);
    chartColors.push(REMAINING_COLOR);
  }

  if (chart) {
    chart.data.labels                       = chartCats;
    chart.data.datasets[0].data            = chartData;
    chart.data.datasets[0].backgroundColor = chartColors;
    chart.update('none');
  } else {
    const ctx = document.getElementById('pie').getContext('2d');
    chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: chartCats,
        datasets: [{
          data:            chartData,
          backgroundColor: chartColors,
          borderWidth:     3,
          borderColor:     '#1d1e21',
          hoverBorderWidth: 4,
        }],
      },
      options: {
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => item.label !== 'Remaining',
            callbacks: {
              label: ctx =>
                ` ${fmt(ctx.raw)} (${budget ? Math.round((ctx.raw / budget) * 100) : 0}% of budget)`,
            },
            backgroundColor: '#0e0f11',
            borderColor:     '#2a2b2e',
            borderWidth:     1,
            titleColor:      '#f0efe8',
            bodyColor:       '#7a7975',
            padding:         10,
          },
        },
        animation: { duration: 400, easing: 'easeInOutQuart' },
      },
    });
  }

  // Legend
  legend.innerHTML = cats.map(c => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${COLORS[c] || '#aaa'}"></div>
      <span>${c} ${fmt(grouped[c])}</span>
    </div>
  `).join('') + (!isOver ? `
    <div class="legend-item">
      <div class="legend-dot" style="background:${REMAINING_COLOR};border:1px solid #444"></div>
      <span>Remaining ${fmt(remaining)}</span>
    </div>
  ` : '');
}

/* ─── Entries List ──────────────────────────────────────── */
function renderEntries(list) {
  const el = document.getElementById('entries-list');
  if (list.length === 0) {
    el.innerHTML = '<div class="no-entries">No entries for this period.</div>';
    return;
  }
  const sorted = [...list].sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = sorted.map(e => `
    <div class="entry-card">
      <div class="entry-dot" style="background:${COLORS[e.category] || '#aaa'}"></div>
      <div class="entry-info">
        <div class="entry-cat">${e.category}</div>
        <div class="entry-date">${new Date(e.date).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        })}</div>
      </div>
      <div class="entry-amount">${fmt(e.amount)}</div>
      <button class="delete-btn" data-id="${e.id}">✕</button>
    </div>
  `).join('');
}

/* ─── Budget Modal ──────────────────────────────────────── */
function openBudgetModal() {
  const input = document.getElementById('budget-input');
  input.value = budgets[period] || '';
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => input.focus(), 100);
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.remove('open');
  }
}

function saveBudget() {
  const val = parseFloat(document.getElementById('budget-input').value);
  if (!val || val <= 0) { showToast('Enter a valid budget'); return; }
  budgets[period] = val;
  save();
  document.getElementById('modal-overlay').classList.remove('open');
  if (chart) { chart.destroy(); chart = null; }
  render();
  showToast('Budget set to ' + fmt(val));
}

/* ─── Add / Delete Entries ──────────────────────────────── */
function addEntry() {
  const amtEl = document.getElementById('amount-input');
  const catEl = document.getElementById('cat-input');
  const amt   = parseFloat(amtEl.value);
  if (!amt || amt <= 0) { showToast('Enter a valid amount'); amtEl.focus(); return; }

  entries.push({
    id:       Date.now().toString(),
    amount:   amt,
    category: catEl.value,
    date:     new Date().toISOString(),
  });

  save();
  amtEl.value = '';
  render();
  showToast(catEl.value + ' — ' + fmt(amt) + ' added');
}

function deleteEntry(id) {
  entries = entries.filter(e => e.id !== id);
  save();
  render();
}

function clearAll() {
  if (!confirm('Clear all entries for all periods?')) return;
  entries = [];
  save();
  render();
}

/* ─── Toast ─────────────────────────────────────────────── */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

/* ─── Event Wiring ──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {

  // Period tabs
  document.querySelectorAll('#period-tabs button').forEach(btn => {
    btn.addEventListener('click', () => setPeriod(btn.dataset.period));
  });

  // Budget edit button
  document.getElementById('budget-edit-btn').addEventListener('click', openBudgetModal);

  // Close modal when clicking the dark overlay (but not the modal itself)
  document.getElementById('modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });

  // Save budget button
  document.getElementById('save-budget-btn').addEventListener('click', saveBudget);

  // Add entry button
  document.getElementById('add-btn').addEventListener('click', addEntry);

  // Clear all button
  document.getElementById('clear-btn').addEventListener('click', clearAll);

  // Entry list — delegate delete clicks to the container
  document.getElementById('entries-list').addEventListener('click', function (e) {
    const btn = e.target.closest('.delete-btn');
    if (btn) deleteEntry(btn.dataset.id);
  });

  // Initial render
  render();
});
