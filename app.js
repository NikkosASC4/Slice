/* ─── Constants ─────────────────────────────────────────── */
const PALETTE = ['#c8f060', '#60c8f0', '#f060c8', '#f0b060', '#7060f0', '#60f0b0', '#f0605f', '#60e0f0'];
const REMAINING_COLOR = '#2a2b2e';
const CADENCE_LABEL = { weekly: 'weekly', monthly: 'monthly', asneeded: 'as needed' };

const DEFAULT_BUCKETS = [
  { name: 'Groceries',          allocated: 350, cadence: 'weekly'  },
  { name: 'Gas',                 allocated: 120, cadence: 'monthly' },
  { name: 'Fun & Wants',         allocated: 200, cadence: 'monthly' },
  { name: 'Household & Random',  allocated: 60,  cadence: 'monthly' },
  { name: 'Car Maintenance',     allocated: 50,  cadence: 'monthly' },
];

/* ─── State ─────────────────────────────────────────────── */
let buckets = loadBuckets();
let entries = JSON.parse(localStorage.getItem('slice_entries') || '[]');
let chart   = null;
let pullingBucketId  = null;   // which bucket the pull-modal is currently targeting
let editingBucketId  = null;   // which bucket the bucket-modal is currently editing (null = creating new)
let spendRange        = 'today';                                            // 'today' | 'week' — which hero figure is showing
let breakdownOpen      = localStorage.getItem('slice_breakdown_open') === '1'; // full bucket breakdown is opt-in, collapsed by default
let pendingConfirmAction = null; // callback queued up by askConfirm(), run if the in-app confirm dialog is accepted

/* ─── Persistence ───────────────────────────────────────── */
function loadBuckets() {
  const stored = localStorage.getItem('slice_buckets');
  if (stored) return JSON.parse(stored);
  // First run (or pre-buckets version of Slice): seed sensible starter buckets.
  const now = new Date().toISOString();
  return DEFAULT_BUCKETS.map((b, i) => ({
    id:        'b_' + Date.now().toString(36) + i,
    name:      b.name,
    allocated: b.allocated,
    cadence:   b.cadence,
    color:     PALETTE[i % PALETTE.length],
    lastReset: now,
  }));
}

function save() {
  localStorage.setItem('slice_buckets', JSON.stringify(buckets));
  localStorage.setItem('slice_entries', JSON.stringify(entries));
}

/* ─── Bucket math ───────────────────────────────────────── */
// A bucket's "current cycle" is every entry logged against it since its last reset.
// Resetting a bucket doesn't delete history — it just moves the cutoff forward, so
// the Recent Activity log stays intact while the bucket's remaining balance goes
// back to full.
function entriesFor(bucketId) {
  const b = buckets.find(x => x.id === bucketId);
  if (!b) return [];
  const cutoff = new Date(b.lastReset);
  return entries.filter(e => e.bucketId === bucketId && new Date(e.date) >= cutoff);
}

function spentOn(bucketId) {
  return entriesFor(bucketId).reduce((s, e) => s + e.amount, 0);
}

function remainingOn(bucketId) {
  const b = buckets.find(x => x.id === bucketId);
  return b.allocated - spentOn(bucketId);
}

/* ─── Safe-to-spend math ────────────────────────────────────
   "Safe to spend" prorates each periodic bucket's remaining balance
   across the days left in its current cycle, so a $350 monthly grocery
   bucket with 20 days left contributes ~$17.50/day rather than looking
   fully available all at once. As-needed buckets don't have a cycle to
   prorate against, so their whole remaining balance counts as available
   right away — it's the same dollars whether you ask about today or
   this week.                                                          */
function cycleLengthDays(b) {
  if (b.cadence === 'weekly') return 7;
  if (b.cadence === 'monthly') {
    const start = new Date(b.lastReset);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    return Math.max(1, Math.round((end - start) / 86400000));
  }
  return null; // as-needed: no cycle
}

function daysLeftInCycle(b) {
  const len = cycleLengthDays(b);
  if (len == null) return null;
  const elapsed = Math.floor((new Date() - new Date(b.lastReset)) / 86400000);
  return Math.max(1, len - elapsed);
}

// Per-bucket contribution to a given horizon ('today' = 1 day, 'week' = up to 7 days).
function spendableFor(b, days) {
  const remaining = remainingOn(b.id);
  if (b.cadence === 'asneeded') return remaining;
  const daysLeft = daysLeftInCycle(b);
  const dailyRate = remaining / daysLeft;
  return dailyRate * Math.min(days, daysLeft);
}

function safeToSpend(range) {
  const days = range === 'week' ? 7 : 1;
  return buckets.reduce((sum, b) => sum + spendableFor(b, days), 0);
}

/* ─── Formatting ────────────────────────────────────────── */
function fmt(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function timeAgoOrDate(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ─── Render ────────────────────────────────────────────── */
function render() {
  renderSpendHero();
  renderOverviewChart();
  renderBuckets();
  renderActivity();
}

/* ─── Spend hero (primary view) ─────────────────────────── */
function renderSpendHero() {
  const amtEl = document.getElementById('spend-amt');
  const subEl = document.getElementById('spend-sub');

  if (buckets.length === 0) {
    amtEl.textContent = '—';
    amtEl.className = 'spend-amt';
    subEl.textContent = 'Add a bucket to see what\'s safe to spend.';
    return;
  }

  const amount = safeToSpend(spendRange);
  const isOver = amount < 0;
  const rangeLabel = spendRange === 'week' ? 'this week' : 'today';

  amtEl.textContent = fmt(amount);
  amtEl.className = 'spend-amt' + (isOver ? ' over' : '');
  subEl.textContent = isOver
    ? 'you\'re over — no safe spend left ' + rangeLabel
    : 'safe to spend ' + rangeLabel + ' across ' + buckets.length + (buckets.length === 1 ? ' bucket' : ' buckets');
}

/* ─── Overview donut: every bucket's spend vs. total remaining ─── */
function renderOverviewChart() {
  const noMsg   = document.getElementById('no-budget-msg');
  const pie     = document.getElementById('pie');
  const center  = document.getElementById('chart-center');
  const totalEl = document.getElementById('total-amt');
  const ofEl    = document.getElementById('budget-of');

  if (buckets.length === 0) {
    noMsg.style.display = 'flex';
    noMsg.querySelector('span').textContent = 'Add a bucket to get started.';
    pie.style.display = 'none';
    center.style.display = 'none';
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  if (typeof Chart === 'undefined') {
    // Chart.js didn't load (offline, blocked script, etc.) — degrade gracefully.
    // The buckets themselves still work fully; only the overview donut is skipped.
    noMsg.style.display = 'flex';
    noMsg.querySelector('span').textContent = 'Chart unavailable offline — your buckets below still work.';
    pie.style.display = 'none';
    center.style.display = 'none';
    return;
  }

  noMsg.style.display = 'none';
  pie.style.display = 'block';
  center.style.display = 'flex';

  const totalAllocated = buckets.reduce((s, b) => s + b.allocated, 0);
  const totalSpent     = buckets.reduce((s, b) => s + spentOn(b.id), 0);
  const totalRemaining = totalAllocated - totalSpent;
  const isOver          = totalRemaining < 0;

  totalEl.innerHTML = fmt(totalRemaining) +
    '<br><span style="font-size:12px;color:var(--muted);font-family:\'DM Sans\',sans-serif;font-weight:400;">remaining</span>';
  totalEl.className = 'total-amt' + (isOver ? ' over' : '');
  ofEl.textContent = 'of ' + fmt(totalAllocated) + ' across ' + buckets.length + (buckets.length === 1 ? ' bucket' : ' buckets');

  const labels = buckets.map(b => b.name);
  const data   = buckets.map(b => Math.max(0, spentOn(b.id)));
  const colors = buckets.map(b => b.color);

  if (!isOver && totalRemaining > 0) {
    labels.push('Unspent');
    data.push(totalRemaining);
    colors.push(REMAINING_COLOR);
  }

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].backgroundColor = colors;
    chart.update('none');
  } else {
    const ctx = document.getElementById('pie').getContext('2d');
    chart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 3, borderColor: '#1d1e21', hoverBorderWidth: 4 }] },
      options: {
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => item.label !== 'Unspent',
            callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)} spent` },
            backgroundColor: '#0e0f11', borderColor: '#2a2b2e', borderWidth: 1,
            titleColor: '#f0efe8', bodyColor: '#7a7975', padding: 10,
          },
        },
        animation: { duration: 400, easing: 'easeInOutQuart' },
      },
    });
  }
}

/* ─── Buckets list ──────────────────────────────────────── */
function renderBuckets() {
  const el = document.getElementById('buckets-list');
  if (buckets.length === 0) {
    el.innerHTML = '<div class="no-entries">No buckets yet — add one to start tracking.</div>';
    return;
  }
  el.innerHTML = buckets.map(b => {
    const remaining = remainingOn(b.id);
    const isOver = remaining < 0;
    const pct = b.allocated > 0 ? Math.min((spentOn(b.id) / b.allocated) * 100, 100) : 0;
    return `
      <div class="bucket-card" data-id="${b.id}">
        <div class="bucket-top">
          <div class="bucket-name-wrap">
            <span class="bucket-dot" style="background:${b.color}"></span>
            <span class="bucket-name">${escapeHtml(b.name)}</span>
            <span class="bucket-cadence">${CADENCE_LABEL[b.cadence] || ''}</span>
          </div>
          <div class="bucket-actions">
            <button class="icon-btn reset-btn" data-id="${b.id}" title="Reset this bucket">⟳</button>
            <button class="icon-btn edit-btn" data-id="${b.id}" title="Edit">✎</button>
          </div>
        </div>
        <div class="bucket-amounts">
          <span class="bucket-remaining ${isOver ? 'over' : ''}">${fmt(remaining)}</span>
          <span class="bucket-of">of ${fmt(b.allocated)}</span>
        </div>
        <div class="progress-track"><div class="progress-fill ${isOver ? 'over' : ''}" style="width:${pct}%"></div></div>
        <button class="bucket-pull-btn" data-id="${b.id}">+ Pull from this bucket</button>
      </div>
    `;
  }).join('');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ─── Recent activity ───────────────────────────────────── */
function renderActivity() {
  const el = document.getElementById('entries-list');
  if (entries.length === 0) {
    el.innerHTML = '<div class="no-entries">No activity logged yet.</div>';
    return;
  }
  const sorted = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 40);
  el.innerHTML = sorted.map(e => {
    const b = buckets.find(x => x.id === e.bucketId);
    const color = b ? b.color : '#aaa';
    const name  = b ? b.name : '(deleted bucket)';
    return `
      <div class="entry-card">
        <div class="entry-dot" style="background:${color}"></div>
        <div class="entry-info">
          <div class="entry-cat">${escapeHtml(name)}${e.note ? ' — ' + escapeHtml(e.note) : ''}</div>
          <div class="entry-date">${timeAgoOrDate(e.date)}</div>
        </div>
        <div class="entry-amount">${fmt(e.amount)}</div>
        <button class="delete-btn" data-id="${e.id}">✕</button>
      </div>
    `;
  }).join('');
}

/* ─── Bucket modal (add / edit) ─────────────────────────── */
function openBucketModal(bucketId) {
  editingBucketId = bucketId || null;
  const title   = document.getElementById('bucket-modal-title');
  const nameEl  = document.getElementById('bucket-name-input');
  const amtEl   = document.getElementById('bucket-amount-input');
  const cadEl   = document.getElementById('bucket-cadence-input');
  const delBtn  = document.getElementById('delete-bucket-btn');

  if (editingBucketId) {
    const b = buckets.find(x => x.id === editingBucketId);
    title.textContent = 'Edit bucket';
    nameEl.value = b.name;
    amtEl.value  = b.allocated;
    cadEl.value  = b.cadence;
    delBtn.style.display = 'block';
  } else {
    title.textContent = 'New bucket';
    nameEl.value = '';
    amtEl.value  = '';
    cadEl.value  = 'monthly';
    delBtn.style.display = 'none';
  }
  document.getElementById('bucket-modal-overlay').classList.add('open');
  setTimeout(() => nameEl.focus(), 100);
}

function closeBucketModal() {
  document.getElementById('bucket-modal-overlay').classList.remove('open');
  editingBucketId = null;
}

function saveBucket() {
  const name = document.getElementById('bucket-name-input').value.trim();
  const amt  = parseFloat(document.getElementById('bucket-amount-input').value);
  const cad  = document.getElementById('bucket-cadence-input').value;

  if (!name) { showToast('Give it a name'); return; }
  if (!amt || amt <= 0) { showToast('Enter a valid amount'); return; }

  if (editingBucketId) {
    const b = buckets.find(x => x.id === editingBucketId);
    b.name = name; b.allocated = amt; b.cadence = cad;
    showToast('Bucket updated');
  } else {
    buckets.push({
      id: 'b_' + Date.now().toString(36),
      name, allocated: amt, cadence: cad,
      color: PALETTE[buckets.length % PALETTE.length],
      lastReset: new Date().toISOString(),
    });
    showToast(name + ' added');
  }
  save();
  closeBucketModal();
  render();
}

function deleteBucket() {
  if (!editingBucketId) return;
  const id = editingBucketId;
  askConfirm('Delete this bucket? Its past activity stays in your history, but it\'ll stop tracking.', function () {
    buckets = buckets.filter(b => b.id !== id);
    save();
    closeBucketModal();
    render();
  });
}

function resetBucket(id) {
  const b = buckets.find(x => x.id === id);
  if (!b) return;
  askConfirm('Reset "' + b.name + '" back to ' + fmt(b.allocated) + '? Past activity stays in your history.', function () {
    b.lastReset = new Date().toISOString();
    save();
    render();
    showToast(b.name + ' reset');
  });
}

function resetAllBuckets() {
  if (buckets.length === 0) return;
  askConfirm('Reset all ' + buckets.length + ' buckets back to full? Past activity stays in your history.', function () {
    const now = new Date().toISOString();
    buckets.forEach(b => b.lastReset = now);
    save();
    render();
    showToast('All buckets reset');
  });
}

/* ─── Pull modal (log a spend against a bucket) ─────────── */
function openPullModal(bucketId) {
  const b = buckets.find(x => x.id === bucketId);
  if (!b) return;
  pullingBucketId = bucketId;
  document.getElementById('pull-modal-title').textContent = 'Pull from ' + b.name;
  document.getElementById('pull-amount-input').value = '';
  document.getElementById('pull-note-input').value = '';
  document.getElementById('pull-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('pull-amount-input').focus(), 100);
}

function closePullModal() {
  document.getElementById('pull-modal-overlay').classList.remove('open');
  pullingBucketId = null;
}

function savePull() {
  const amt  = parseFloat(document.getElementById('pull-amount-input').value);
  const note = document.getElementById('pull-note-input').value.trim();
  if (!amt || amt <= 0) { showToast('Enter a valid amount'); return; }
  if (!pullingBucketId) return;

  entries.push({
    id: Date.now().toString(),
    bucketId: pullingBucketId,
    amount: amt,
    note,
    date: new Date().toISOString(),
  });
  save();
  const b = buckets.find(x => x.id === pullingBucketId);
  closePullModal();
  render();
  showToast(fmt(amt) + ' pulled from ' + (b ? b.name : ''));
}

function deleteEntry(id) {
  entries = entries.filter(e => e.id !== id);
  save();
  render();
}

function clearHistory() {
  askConfirm('Clear all logged activity? Bucket totals will reset to full too.', function () {
    entries = [];
    const now = new Date().toISOString();
    buckets.forEach(b => b.lastReset = now);
    save();
    render();
  });
}

/* ─── Confirm dialog ─────────────────────────────────────────
   In-app replacement for window.confirm(). The native dialog doesn't
   reliably work inside a sandboxed artifact frame (it can return
   immediately without waiting for a response), which made every
   reset/delete/clear action look broken. This uses the same bottom-sheet
   modal pattern as the rest of the app instead.                        */
function askConfirm(message, onConfirm) {
  document.getElementById('confirm-modal-msg').textContent = message;
  pendingConfirmAction = onConfirm;
  document.getElementById('confirm-modal-overlay').classList.add('open');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal-overlay').classList.remove('open');
  pendingConfirmAction = null;
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

  // Spend hero: Today/Week toggle
  document.getElementById('spend-toggle').addEventListener('click', function (e) {
    const btn = e.target.closest('.spend-toggle-btn');
    if (!btn) return;
    spendRange = btn.dataset.range;
    this.querySelectorAll('.spend-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderSpendHero();
  });

  // Full bucket breakdown: opt-in, collapsed by default
  const chartSection = document.getElementById('chart-section');
  const breakdownBtn = document.getElementById('breakdown-toggle');
  chartSection.classList.toggle('open', breakdownOpen);
  breakdownBtn.textContent = (breakdownOpen ? 'Hide full breakdown ▴' : 'Show full breakdown ▾');
  breakdownBtn.addEventListener('click', function () {
    breakdownOpen = !breakdownOpen;
    localStorage.setItem('slice_breakdown_open', breakdownOpen ? '1' : '0');
    chartSection.classList.toggle('open', breakdownOpen);
    this.textContent = breakdownOpen ? 'Hide full breakdown ▴' : 'Show full breakdown ▾';
    // Chart.js sizes itself against its container; when the breakdown was collapsed
    // (max-height: 0) at chart-creation time, the canvas can end up stuck at 0×0.
    // Nudge it to remeasure once the container has actually expanded.
    if (breakdownOpen && chart) setTimeout(() => chart.resize(), 260);
  });

  document.getElementById('add-bucket-btn').addEventListener('click', () => openBucketModal(null));
  document.getElementById('reset-all-btn').addEventListener('click', resetAllBuckets);
  document.getElementById('save-bucket-btn').addEventListener('click', saveBucket);
  document.getElementById('delete-bucket-btn').addEventListener('click', deleteBucket);
  document.getElementById('save-pull-btn').addEventListener('click', savePull);
  document.getElementById('clear-btn').addEventListener('click', clearHistory);

  document.getElementById('bucket-modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) closeBucketModal();
  });
  document.getElementById('pull-modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) closePullModal();
  });
  document.getElementById('confirm-modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) closeConfirmModal();
  });
  document.getElementById('confirm-modal-cancel').addEventListener('click', closeConfirmModal);
  document.getElementById('confirm-modal-ok').addEventListener('click', function () {
    const action = pendingConfirmAction;
    closeConfirmModal();
    if (action) action();
  });

  // Delegate bucket-card button clicks (cards are re-rendered on every change)
  document.getElementById('buckets-list').addEventListener('click', function (e) {
    const resetBtn = e.target.closest('.reset-btn');
    const editBtn  = e.target.closest('.edit-btn');
    const pullBtn  = e.target.closest('.bucket-pull-btn');
    if (resetBtn) resetBucket(resetBtn.dataset.id);
    else if (editBtn) openBucketModal(editBtn.dataset.id);
    else if (pullBtn) openPullModal(pullBtn.dataset.id);
  });

  document.getElementById('entries-list').addEventListener('click', function (e) {
    const btn = e.target.closest('.delete-btn');
    if (btn) deleteEntry(btn.dataset.id);
  });

  // Enter-to-submit inside the two modals
  document.getElementById('bucket-amount-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveBucket(); });
  document.getElementById('pull-amount-input').addEventListener('keydown', e => { if (e.key === 'Enter') savePull(); });

  render();
});