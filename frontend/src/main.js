import "./style.css";

const TOKEN_KEY = "gluekettle_token";
const LABELS = { cold: "冷锅", boiling: "熬煮中", drawn: "已出胶" };

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "请求失败");
  return data;
}

const app = document.getElementById("app");
const state = {
  ready: Boolean(localStorage.getItem(TOKEN_KEY)),
  user: null,
  page: "bench",
  workshops: null,
  board: null,
  benchWorkshopId: "",
  logs: [],
  filterWorkshopId: "",
  picked: null,
  peak: "96",
  err: "",
  username: "admin",
  password: "123456",
};

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

function workshopName(id) {
  return (state.workshops || []).find((w) => w.id === id)?.name || `坊#${id}`;
}

async function loadWorkshops() {
  state.workshops = (await api("/api/workshops")).workshops;
  if (!state.benchWorkshopId && state.workshops.length) {
    state.benchWorkshopId = state.workshops[0].id;
  }
}

async function loadBoard() {
  const q = state.benchWorkshopId ? `?workshop_id=${state.benchWorkshopId}` : "";
  state.board = await api(`/api/board${q}`);
  state.benchWorkshopId = state.board.workshopId;
  if (state.picked) {
    state.picked = state.board.kettles.find((k) => k.id === state.picked.id) || null;
  }
}

async function loadLogs() {
  const q = state.filterWorkshopId ? `?workshop_id=${state.filterWorkshopId}` : "";
  state.logs = (await api(`/api/seal-logs${q}`)).logs;
}

async function go(page) {
  state.page = page;
  state.err = "";
  try {
    if (page === "bench") {
      await loadWorkshops();
      await loadBoard();
    } else {
      await loadWorkshops();
      await loadLogs();
    }
  } catch (e) {
    state.err = e.message;
  }
  render();
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  state.ready = false;
  state.user = null;
  state.board = null;
  state.workshops = null;
  state.picked = null;
  render();
}

function renderNav() {
  const nav = el(`<nav class="topnav">
    <span class="brand">骨巷熬胶坊</span>
    <button class="navbtn ${state.page === "bench" ? "active" : ""}" data-p="bench">锅位作业台</button>
    <button class="navbtn ${state.page === "seal" ? "active" : ""}" data-p="seal">封灶台</button>
    <span class="spacer"></span>
    <span class="who">${state.user.username} · ${state.user.role === "admin" ? "管理员" : "操作工"}</span>
    <button id="logout">退出</button>
  </nav>`);
  nav.querySelectorAll(".navbtn").forEach((b) => {
    b.onclick = () => go(b.dataset.p);
  });
  nav.querySelector("#logout").onclick = logout;
  return nav;
}

function workshopOptions(value) {
  return (state.workshops || [])
    .map((w) => `<option value="${w.id}" ${String(w.id) === String(value) ? "selected" : ""}>${w.name}</option>`)
    .join("");
}

function renderBench() {
  const box = el(`<div class="wrap">
    <div class="head-row">
      <h1>锅位作业台</h1>
      <select id="shop" class="shop-select"></select>
    </div>
    <p>${state.board.alley} · 点锅登记峰值；出胶须最近峰值 ≥ 90℃</p>
    <div id="sealbanner"></div>
    <div class="row"></div>
    <section class="drawer" id="drawer"></section>
    <p class="err">${state.err}</p>
  </div>`);
  const select = box.querySelector("#shop");
  select.innerHTML = workshopOptions(state.benchWorkshopId);
  select.onchange = () => {
    state.benchWorkshopId = Number(select.value);
    state.picked = null;
    loadBoard().then(render).catch((e) => {
      state.err = e.message;
      render();
    });
  };

  const banner = box.querySelector("#sealbanner");
  if (state.board.sealRaised) {
    banner.append(
      el(`<div class="seal-banner raised">🚩 本坊封灶旗已升起（${state.board.sealChangedBy || "—"} 于 ${fmtTime(
        state.board.sealChangedAt
      )} 升旗）· 封灶期间禁止登记峰值；改锅态不受影响</div>`)
    );
  } else {
    banner.append(el(`<div class="seal-banner down">⚐ 封灶旗未升起，峰值可正常登记</div>`));
  }

  const row = box.querySelector(".row");
  state.board.kettles.forEach((k) => {
    const btn = el(`<button class="kettle ${k.status}"><strong>${k.code}</strong><span>${LABELS[k.status]}</span></button>`);
    btn.onclick = () => {
      state.picked = k;
      render();
    };
    row.append(btn);
  });

  const d = box.querySelector("#drawer");
  if (state.picked) {
    const sealed = state.board.sealRaised;
    d.innerHTML = `<h3>${state.picked.code} · ${LABELS[state.picked.status]}</h3>
      <p>最近峰值：${state.picked.latestPeakC ?? "无"} ℃ · ${state.picked.cookCount} 次</p>
      <input id="peak" value="${state.peak}" ${sealed ? "disabled" : ""} />
      <button id="log" ${sealed ? "disabled" : ""}>登记峰值</button>
      ${sealed ? '<p class="seal-block">🚩 封灶旗已升起，峰值不得入库</p>' : ""}
      <div>
        <button data-s="cold">冷锅</button>
        <button data-s="boiling">熬煮中</button>
        <button data-s="drawn">已出胶</button>
      </div>`;
    d.querySelector("#log").onclick = async () => {
      // 点击瞬间再读一次本坊封灶状态：升起即中文挡住，不发请求、不入库。
      if (state.board.sealRaised) {
        state.err = "本坊封灶旗已升起，封灶期间不得登记峰值";
        render();
        return;
      }
      state.err = "";
      state.peak = d.querySelector("#peak").value;
      try {
        await api(`/api/kettles/${state.picked.id}/cooks`, {
          method: "POST",
          body: JSON.stringify({ peakTempC: Number(state.peak) }),
        });
        await loadBoard();
        render();
      } catch (ex) {
        state.err = ex.message;
        render();
      }
    };
    d.querySelectorAll("[data-s]").forEach((b) => {
      b.onclick = async () => {
        state.err = "";
        try {
          await api(`/api/kettles/${state.picked.id}/status`, {
            method: "POST",
            body: JSON.stringify({ status: b.dataset.s }),
          });
          await loadBoard();
          render();
        } catch (ex) {
          state.err = ex.message;
          render();
        }
      };
    });
  }
  return box;
}

function renderSeal() {
  const isAdmin = state.user.role === "admin";
  const box = el(`<div class="wrap">
    <div class="head-row">
      <h1>封灶台</h1>
      <select id="wfilter" class="shop-select">
        <option value="">全部坊</option>
        ${workshopOptions(state.filterWorkshopId)}
      </select>
    </div>
    <p>${isAdmin ? "可升旗、降旗。" : "只读：只有管理员能升旗降旗。"}每坊现行封灶记录至多一条。</p>
    <p class="err">${state.err}</p>
    <div class="seal-cards"></div>
    <h2>改旗记录</h2>
    <table class="seal-table">
      <thead><tr><th>坊</th><th>封灶旗</th><th>改旗人</th><th>改旗时刻</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>`);

  box.querySelector("#wfilter").onchange = (e) => {
    state.filterWorkshopId = e.target.value ? Number(e.target.value) : "";
    loadLogs().then(render).catch((err) => {
      state.err = err.message;
      render();
    });
  };

  const cards = box.querySelector(".seal-cards");
  state.workshops.forEach((w) => {
    const card = el(`<div class="seal-card ${w.sealRaised ? "raised" : "down"}">
      <div class="seal-card-head">
        <strong>${w.name}</strong>
        <span class="badge ${w.sealRaised ? "raised" : "down"}">${w.sealRaised ? "🚩 已升起" : "⚐ 未升起"}</span>
      </div>
      <p class="muted">${w.alley}</p>
      <p class="meta">改旗人：${w.changedBy || "—"} ｜ 改旗时刻：${fmtTime(w.changedAt)}</p>
      <div class="seal-actions"></div>
    </div>`);
    const actions = card.querySelector(".seal-actions");
    if (isAdmin) {
      if (w.sealRaised) {
        const b = el(`<button class="btn-lower">降旗</button>`);
        b.onclick = () => changeSeal(w.id, false);
        actions.append(b);
      } else {
        const b = el(`<button class="btn-raise">升旗</button>`);
        b.onclick = () => changeSeal(w.id, true);
        actions.append(b);
      }
    } else {
      actions.append(el(`<span class="readonly">操作工只读</span>`));
    }
    cards.append(card);
  });

  const tbody = box.querySelector(".seal-table tbody");
  if (!state.logs.length) {
    tbody.append(el(`<tr><td colspan="4" class="muted center">暂无改旗记录</td></tr>`));
  }
  state.logs.forEach((log) => {
    tbody.append(
      el(`<tr>
        <td>${log.workshopName || workshopName(log.workshopId)}</td>
        <td><span class="badge ${log.raised ? "raised" : "down"}">${log.raised ? "🚩 升起" : "⚐ 降下"}</span></td>
        <td>${log.changedBy}</td>
        <td>${fmtTime(log.changedAt)}</td>
      </tr>`)
    );
  });
  return box;
}

async function changeSeal(workshopId, raised) {
  state.err = "";
  try {
    await api(`/api/workshops/${workshopId}/seal`, {
      method: "POST",
      body: JSON.stringify({ raised }),
    });
    await loadWorkshops();
    await loadLogs();
    if (state.page === "bench") await loadBoard();
    render();
  } catch (e) {
    state.err = e.message;
    render();
  }
}

function render() {
  app.innerHTML = "";
  if (!state.ready) {
    renderLogin();
    return;
  }
  if (!state.user || !state.workshops) {
    app.append(el(`<div class="wrap">${state.err || "装载中…"}</div>`));
    return;
  }
  app.append(renderNav());
  app.append(state.page === "bench" ? renderBench() : renderSeal());
}

function renderLogin() {
  const box = el(`<div class="wrap">
    <h1>骨巷熬胶坊</h1>
    <p>一排熬锅作业台，原生页面，无前端框架。</p>
    <form autocomplete="off">
      <label>用户名
        <input name="u" autocomplete="off" value="${state.username}" />
      </label>
      <label>密码
        <input name="p" type="password" autocomplete="off" value="${state.password}" />
      </label>
      <p class="hint">已预填 admin / 123456，另有 worker / 123456</p>
      <button>登录</button>
    </form>
    <p class="err">${state.err}</p>
  </div>`);
  box.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    state.err = "";
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: box.querySelector("[name=u]").value,
          password: box.querySelector("[name=p]").value,
        }),
      });
      localStorage.setItem(TOKEN_KEY, data.access_token);
      state.user = data.user;
      state.ready = true;
      await go("bench");
    } catch (ex) {
      state.err = ex.message;
      render();
    }
  };
  app.append(box);
}

async function boot() {
  if (!state.ready) {
    render();
    return;
  }
  try {
    state.user = await api("/api/auth/me");
    await go("bench");
  } catch (e) {
    state.ready = false;
    state.err = e.message;
    render();
  }
}

boot();
