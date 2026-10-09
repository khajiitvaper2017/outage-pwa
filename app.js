const ENDPOINT = "https://www.poe.pl.ua/customs/dynamicgpv-info.php";
const POLL_MS = 30 * 60 * 1000;
const CLOCK_MS = 60 * 1000;

let schedules = [];
let lastUpdated = "";
let loading = false;
let errorText = "";
let lastAlertKey = "";
let persistentNotifId = null;

// ——— helpers (from QML) ———
function stripTags(value) {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function dateFromText(value) {
  const months = {
    січня: 0, лютого: 1, березня: 2, квітня: 3, травня: 4, червня: 5,
    липня: 6, серпня: 7, вересня: 8, жовтня: 9, листопада: 10, грудня: 11
  };
  const match = value.match(/(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s+(\d{4})/i);
  if (!match) return new Date();
  return new Date(Number(match[3]), months[match[2].toLowerCase()], Number(match[1]));
}

function lastDateBefore(value) {
  const expression = /(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s+\d{4})/gi;
  let match, last = "";
  while ((match = expression.exec(value)) !== null) last = match[1];
  return dateFromText(last);
}

function timeLabel(index) {
  const minutes = index * 30;
  return ("0" + Math.floor(minutes / 60)).slice(-2) + ":" + (minutes % 60 ? "30" : "00");
}

function minutes(time) {
  const parts = time.split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function parseTable(tableHtml, prefix) {
  const date = lastDateBefore(prefix);
  const rows = [];
  let currentQueue = "";
  const rowMatches = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  rowMatches.forEach(rowHtml => {
    const cells = rowHtml.match(/<td\b[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 3) return;
    const hasQueueCell = /turnoff-scheduleui-table-queue/i.test(cells[0]);
    if (hasQueueCell) currentQueue = stripTags(cells[0]).replace(/\s*черга\s*/i, "");
    const subqueue = stripTags(cells[hasQueueCell ? 1 : 0]);
    const scheduleCells = cells.slice(hasQueueCell ? 2 : 1);
    if (!currentQueue || !subqueue || scheduleCells.length < 2) return;

    const states = scheduleCells.map(cell => {
      const classes = (cell.match(/class=["']([^"']*)["']/i) || ["", ""])[1];
      if (/\blight_2\b/.test(classes)) return "off";
      if (/\blight_3\b/.test(classes)) return "possible";
      return "on";
    });

    const intervals = [];
    let state = states[0];
    let start = 0;
    for (let i = 1; i <= states.length; i++) {
      if (i === states.length || states[i] !== state) {
        intervals.push({
          state,
          start: timeLabel(start),
          end: i === 48 ? "00:00" : timeLabel(i)
        });
        state = states[i];
        start = i;
      }
    }
    rows.push({
      queue: currentQueue + "." + subqueue,
      date,
      dateText: date.toLocaleDateString("uk-UA"),
      intervals
    });
  });
  return rows;
}

function parseResponse(html) {
  const result = [];
  const tables = html.match(/<table\b[^>]*turnoff-scheduleui-table[^>]*>[\s\S]*?<\/table>/gi) || [];
  let cursor = 0;
  tables.forEach(table => {
    const position = html.indexOf(table, cursor);
    result.push(...parseTable(table, html.slice(0, position)));
    cursor = position + table.length;
  });
  return result;
}

// ——— config ———
function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem("outageConfig") || "{}");
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  localStorage.setItem("outageConfig", JSON.stringify(cfg));
}

function selectedQueue() {
  return loadConfig().selectedQueue || "";
}

function setSelectedQueue(q) {
  const cfg = loadConfig();
  cfg.selectedQueue = q;
  saveConfig(cfg);
}

function countPossibleAsOn() {
  return loadConfig().countPossibleAsOn !== false;
}

// ——— schedule logic ———
function visibleSchedules() {
  const q = selectedQueue();
  if (!q) return schedules;
  return schedules.filter(item => item.queue === q);
}

function visibleIntervals(item) {
  const now = new Date();
  const isToday = item.date.toDateString() === now.toDateString();
  const current = now.getHours() * 60 + now.getMinutes();
  const treatPossibleAsOn = countPossibleAsOn();

  // Normalize state: possible → on when option is on
  const normalized = item.intervals.map(iv => ({
    ...iv,
    state: treatPossibleAsOn && iv.state === "possible" ? "on" : iv.state
  }));

  // Merge consecutive intervals with the same state
  const merged = [];
  for (const iv of normalized) {
    const prev = merged[merged.length - 1];
    if (prev && prev.state === iv.state && prev.end === iv.start) {
      prev.end = iv.end;
    } else {
      merged.push({ state: iv.state, start: iv.start, end: iv.end });
    }
  }

  return merged.filter(interval => {
    if (!isToday) return item.date > now;
    const end = interval.end === "00:00" ? 1440 : minutes(interval.end);
    return end > current;
  });
}

function dailyTotals(item) {
  const totals = { on: 0, possible: 0, off: 0 };
  item.intervals.forEach(interval => {
    const start = minutes(interval.start);
    const end = interval.end === "00:00" ? 1440 : minutes(interval.end);
    totals[interval.state] += end - start;
  });
  if (countPossibleAsOn()) {
    totals.on += totals.possible;
    totals.possible = 0;
  }
  return totals;
}

function formatDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const remaining = totalMinutes % 60;
  if (hours && remaining) return `${hours} год ${remaining} хв`;
  if (hours) return `${hours} год`;
  return `${remaining} хв`;
}

function totalsText(item) {
  const t = dailyTotals(item);
  const parts = [`Світло: ${formatDuration(t.on)}`, `Відкл: ${formatDuration(t.off)}`];
  if (t.possible > 0) parts.push(`Невпевн: ${formatDuration(t.possible)}`);
  return parts.join(" · ");
}

function nextOutage() {
  const now = new Date();
  const rows = visibleSchedules();
  let result = null;
  rows.forEach(item => {
    item.intervals.forEach(interval => {
      if (interval.state !== "off") return;
      const date = new Date(item.date);
      const [h, m] = interval.start.split(":").map(Number);
      date.setHours(h, m, 0, 0);
      if (date > now && (!result || date < result.date)) {
        result = { date, time: interval.start, queue: item.queue };
      }
    });
  });
  return result;
}

function nextTransition() {
  const now = new Date();
  const rows = visibleSchedules();
  const current = now.getHours() * 60 + now.getMinutes();
  const treatPossibleAsOn = countPossibleAsOn();
  const active = [];

  rows.forEach(item => {
    if (item.date.toDateString() !== now.toDateString()) return;
    item.intervals.forEach(interval => {
      const start = minutes(interval.start);
      const end = interval.end === "00:00" ? 1440 : minutes(interval.end);
      if (start <= current && current < end) {
        const state = treatPossibleAsOn && interval.state === "possible" ? "on" : interval.state;
        active.push({ item, state });
      }
    });
  });

  const offQueues = new Set(active.filter(entry => entry.state === "off").map(entry => entry.item.queue));
  const targetState = offQueues.size ? "on" : "off";
  const targetRows = offQueues.size ? rows.filter(item => offQueues.has(item.queue)) : rows;
  let result = null;

  targetRows.forEach(item => {
    item.intervals.forEach(interval => {
      const state = treatPossibleAsOn && interval.state === "possible" ? "on" : interval.state;
      if (state !== targetState) return;
      const date = new Date(item.date);
      const [h, m] = interval.start.split(":").map(Number);
      date.setHours(h, m, 0, 0);
      if (date > now && (!result || date < result.date)) {
        result = { date, time: interval.start, queue: item.queue };
      }
    });
  });

  return {
    event: result,
    label: offQueues.size ? "Світло з’явиться" : "Наступне відключення"
  };
}

function minutesUntil(event) {
  return Math.ceil(Math.max(0, event.date - new Date()) / 60000);
}

function countdown(event) {
  const total = minutesUntil(event);
  if (total < 1) return "<1 хв";
  if (total < 60) return `${total} хв`;
  return `${Math.floor(total / 60)} год ${total % 60} хв`;
}

// ——— notifications ———
async function enableNotifications() {
  if (!("Notification" in window)) {
    alert("Сповіщення не підтримуються в цьому браузері");
    return;
  }

  // Already decided
  if (Notification.permission === "granted") {
    updateNotifyButton();
    updatePersistentNotification();
    sendOutageAlert();
    return;
  }
  if (Notification.permission === "denied") {
    alert(
      "Сповіщення заборонені.\n\n" +
      "Відкрийте налаштування сайту в браузері → Дозволи → Сповіщення → Дозволити."
    );
    updateNotifyButton();
    return;
  }

  // Must be called from a user gesture
  try {
    const perm = await Notification.requestPermission();
    updateNotifyButton();
    if (perm === "granted") {
      // Show a test notification so the user sees it works
      new Notification("Сповіщення увімкнено", {
        body: "Ви отримуватимете попередження про відключення",
        tag: "outage-welcome",
        icon: "icon.svg"
      });
      updatePersistentNotification();
      sendOutageAlert();
    } else if (perm === "denied") {
      alert("Дозвіл відхилено. Сповіщення не будуть показуватися.");
    }
  } catch (e) {
    console.warn(e);
    alert("Не вдалося запитати дозвіл: " + (e.message || e));
  }
}

function updateNotifyButton() {
  const btn = document.getElementById("btnNotify");
  if (!btn) return;
  const perm = ("Notification" in window) ? Notification.permission : "unsupported";
  if (perm === "granted") {
    btn.textContent = "Сповіщення увімкнено ✓";
    btn.disabled = true;
  } else if (perm === "denied") {
    btn.textContent = "Сповіщення заборонені";
    btn.disabled = false; // allow retry / show instructions
  } else {
    btn.textContent = "Увімкнути сповіщення";
    btn.disabled = false;
  }
}

function sendOutageAlert() {
  if (Notification.permission !== "granted") return;
  const event = nextOutage();
  if (!event) {
    lastAlertKey = "";
    return;
  }
  const remaining = minutesUntil(event);
  const threshold = remaining <= 5 ? 5 : remaining <= 10 ? 10 : remaining <= 20 ? 20 : 0;
  if (!threshold) return;
  const key = event.queue + "|" + event.date.getTime() + "|" + threshold;
  if (key === lastAlertKey) return;
  lastAlertKey = key;
  new Notification("Відключення наближається", {
    body: `Черга ${event.queue}: о ${event.time} — приблизно ${remaining} хв`,
    tag: "outage-alert",
    requireInteraction: true,
    icon: "icon.svg"
  });
}

function updatePersistentNotification() {
  if (Notification.permission !== "granted") return;
  const event = nextOutage();
  const title = event
    ? `Відкл. о ${event.time} (${countdown(event)})`
    : "Немає найближчих відключень";
  const body = event
    ? `Черга ${event.queue}`
    : lastUpdated ? `Оновлено ${lastUpdated}` : "";

  // Close previous tagged notification and show updated one
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SHOW_PERSISTENT",
      title,
      body
    });
  } else {
    new Notification(title, {
      body,
      tag: "outage-persistent",
      silent: true,
      icon: "icon.svg"
    });
  }
}

// ——— fetch ———
async function poll() {
  if (loading) return;
  loading = true;
  errorText = "";
  updateStatus();
  document.getElementById("btnRefresh").disabled = true;

  try {
    const res = await fetch(ENDPOINT, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parsed = parseResponse(html);
    if (!parsed.length) throw new Error("Розклад не знайдено");
    schedules = parsed;
    updateConfigFromParsed(parsed);
    lastUpdated = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
    errorText = "";
    sendOutageAlert();
    updatePersistentNotification();
  } catch (e) {
    errorText = e.message || "Помилка мережі";
  } finally {
    loading = false;
    document.getElementById("btnRefresh").disabled = false;
    render();
  }
}

function updateConfigFromParsed(parsed) {
  const available = [...new Set(parsed.map(i => i.queue))];
  let q = selectedQueue();
  if (!available.includes(q)) q = available[0] || "";
  setSelectedQueue(q);
}

// ——— UI ———
function updateStatus() {
  const el = document.getElementById("status");
  if (loading) {
    el.textContent = "Оновлення…";
    el.className = "status";
  } else if (errorText) {
    el.textContent = errorText;
    el.className = "status error";
  } else if (lastUpdated) {
    el.textContent = `Оновлено о ${lastUpdated}`;
    el.className = "status";
  } else {
    el.textContent = "";
  }
}

function render() {
  updateStatus();

  // Show the next power-on while currently in an outage; otherwise show the next outage.
  const transition = nextTransition();
  const event = transition.event;
  const nextEl = document.getElementById("nextOutage");
  document.getElementById("nextLabel").textContent = transition.label;
  if (event) {
    nextEl.style.display = "block";
    document.getElementById("nextTime").textContent = event.time;
    document.getElementById("nextCountdown").textContent = "через " + countdown(event);
    document.getElementById("nextQueue").textContent = "Черга " + event.queue;
  } else {
    nextEl.style.display = schedules.length ? "block" : "none";
    document.getElementById("nextTime").textContent = "—";
    document.getElementById("nextCountdown").textContent = "Немає найближчих";
    document.getElementById("nextQueue").textContent = "";
  }

  // schedules
  const container = document.getElementById("schedules");
  const empty = document.getElementById("empty");
  const visible = visibleSchedules();
  container.innerHTML = "";
  if (!visible.length && !loading && !errorText) {
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
    visible.forEach(item => {
      const intervals = visibleIntervals(item);
      if (!intervals.length && item.date.toDateString() === new Date().toDateString()) return;
      const sec = document.createElement("div");
      sec.className = "queue-section";
      sec.innerHTML = `
        <div class="queue-title">
          ${item.queue} · ${item.dateText}
          <span class="totals">${totalsText(item)}</span>
        </div>
        <div class="intervals">
          ${intervals.map(iv =>
            `<span class="interval ${iv.state}" title="${
              iv.state === "off" ? "Відключення" : iv.state === "possible" ? "Можливе" : "Світло"
            }">${iv.start}–${iv.end}</span>`
          ).join("")}
        </div>`;
      container.appendChild(sec);
    });
  }

  // single-queue picker — 2 rows: *.1 on top, *.2 on bottom
  // e.g.  1.1  2.1  3.1  4.1  5.1  6.1
  //       1.2  2.2  3.2  4.2  5.2  6.2
  const available = [...new Set(schedules.map(i => i.queue))];
  const byNum = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const row1 = available.filter(q => /\.1$/.test(q)).sort(byNum);
  const row2 = available.filter(q => /\.2$/.test(q)).sort(byNum);
  const others = available.filter(q => !/\.[12]$/.test(q)).sort(byNum);
  // fall back if naming differs
  const top = row1.length ? row1 : available.sort(byNum).slice(0, Math.ceil(available.length / 2));
  const bot = row2.length ? row2 : available.sort(byNum).slice(Math.ceil(available.length / 2));
  // pad shorter row so columns align
  const cols = Math.max(top.length, bot.length, others.length, 1);
  while (top.length < cols) top.push(null);
  while (bot.length < cols) bot.push(null);
  const displayList = [...top, ...bot];

  const grid = document.getElementById("queueGrid");
  const current = selectedQueue();
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.innerHTML = displayList.map(q =>
    q
      ? `<button type="button" class="queue-chip${q === current ? " selected" : ""}" data-queue="${q}">${q}</button>`
      : `<span></span>`
  ).join("");
  grid.querySelectorAll(".queue-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      setSelectedQueue(btn.dataset.queue);
      render();
      updatePersistentNotification();
    });
  });

  // count possible
  const cp = document.getElementById("countPossible");
  cp.checked = countPossibleAsOn();
  cp.onchange = () => {
    const cfg = loadConfig();
    cfg.countPossibleAsOn = cp.checked;
    saveConfig(cfg);
    render();
  };

  updateNotifyButton();
}

// ——— init ———
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(console.warn);
}

updateNotifyButton();
poll();
setInterval(poll, POLL_MS);
setInterval(() => {
  render();
  sendOutageAlert();
  updatePersistentNotification();
}, CLOCK_MS);

// Update notification when page becomes visible
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updatePersistentNotification();
    render();
  }
});
