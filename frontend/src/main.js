import "./style.css";

const TOKEN_KEY = "gluekettle_token";
const LABELS = { cold: "冷锅", boiling: "熬煮中", drawn: "已出胶" };
const ROLE_LABELS = { admin: "管理员", worker: "操作工" };

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
  view: "board",
  role: "",
  board: null,
  seals: null,
  sealFilter: "",
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

async function refresh() {
  state.board = await api("/api/board");
  if (state.picked) {
    state.picked = state.board.kettles.find((k) => k.id === state.picked.id) || state.board.kettles[0];
  }
  render();
}

async function loadSeals() {
  state.seals = (await api("/api/seals")).seals;
  render();
}

async function goto(view) {
  state.view = view;
  state.err = "";
  try {
    if (view === "seals") await loadSeals();
    else await refresh();
  } catch (ex) {
    state.err = ex.message;
    render();
  }
}

function sealLabel(raised) {
  if (raised === null || raised === undefined) return "未建旗";
  return raised ? "已升起" : "已降下";
}

function sealClass(raised) {
  if (raised === null || raised === undefined) return "seal-none";
  return raised ? "seal-raised" : "seal-lowered";
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
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
      state.ready = true;
      state.role = data.user.role;
      state.username = data.user.username;
      await refresh();
    } catch (ex) {
      state.err = ex.message;
      render();
    }
  };
  app.append(box);
}

function renderNav() {
  const nav = el(`<nav class="top">
    <button data-v="board">锅位作业台</button>
    <button data-v="seals">封灶台</button>
    <span class="who">${state.username} · ${ROLE_LABELS[state.role] || state.role}</span>
  </nav>`);
  nav.querySelector(`[data-v=${state.view}]`).classList.add("active");
  nav.querySelectorAll("button").forEach((b) => {
    b.onclick = () => goto(b.dataset.v);
  });
  app.append(nav);
}

function renderBoard() {
  if (!state.board) {
    app.append(el(`<div class="wrap">${state.err || "装载锅位…"}</div>`));
    return;
  }
  const box = el(`<div class="wrap">
    <h1>${state.board.workshop}</h1>
    <p>${state.board.alley} · 点锅登记峰值；出胶须最近峰值 ≥ 90℃</p>
    ${state.board.sealRaised ? `<p class="seal-warn">封灶旗已升起：该坊暂停登记峰值（改锅态不受影响）</p>` : ""}
    <div class="row"></div>
    <section class="drawer"></section>
    <p class="err">${state.err}</p>
  </div>`);
  const row = box.querySelector(".row");
  state.board.kettles.forEach((k) => {
    const btn = el(`<button class="kettle ${k.status}"><strong>${k.code}</strong><span>${LABELS[k.status]}</span></button>`);
    btn.onclick = () => {
      state.picked = k;
      render();
    };
    row.append(btn);
  });
  if (state.picked) {
    const d = box.querySelector(".drawer");
    d.innerHTML = `<h3>${state.picked.code} · ${LABELS[state.picked.status]}</h3>
      <p>最近峰值：${state.picked.latestPeakC ?? "无"} ℃ · ${state.picked.cookCount} 次</p>
      <input id="peak" value="${state.peak}" />
      <button id="log">登记峰值</button>
      <div>
        <button data-s="cold">冷锅</button>
        <button data-s="boiling">熬煮中</button>
        <button data-s="drawn">已出胶</button>
      </div>`;
    d.querySelector("#log").onclick = async () => {
      state.err = "";
      state.peak = d.querySelector("#peak").value;
      try {
        state.picked = await api(`/api/kettles/${state.picked.id}/cooks`, {
          method: "POST",
          body: JSON.stringify({ peakTempC: Number(state.peak) }),
        });
        await refresh();
      } catch (ex) {
        state.err = ex.message;
        render();
      }
    };
    d.querySelectorAll("[data-s]").forEach((b) => {
      b.onclick = async () => {
        state.err = "";
        try {
          state.picked = await api(`/api/kettles/${state.picked.id}/status`, {
            method: "POST",
            body: JSON.stringify({ status: b.dataset.s }),
          });
          await refresh();
        } catch (ex) {
          state.err = ex.message;
          render();
        }
      };
    });
  }
  app.append(box);
}

function renderSeals() {
  if (!state.seals) {
    app.append(el(`<div class="wrap">${state.err || "装载封灶旗…"}</div>`));
    return;
  }
  const isAdmin = state.role === "admin";
  const box = el(`<div class="wrap">
    <h1>封灶台</h1>
    <p>每坊最多一面现行封灶旗；旗升起则该坊停登峰值。${isAdmin ? "" : "操作工只读。"}</p>
    <label>按坊筛选
      <select id="filter">
        <option value="">全部坊</option>
        ${state.seals
          .map(
            (s) =>
              `<option value="${s.workshopId}" ${String(s.workshopId) === state.sealFilter ? "selected" : ""}>${s.workshop}</option>`
          )
          .join("")}
      </select>
    </label>
    <table class="seals">
      <thead><tr><th>坊</th><th>封灶旗</th><th>改旗人</th><th>改旗时刻</th>${isAdmin ? "<th>操作</th>" : ""}</tr></thead>
      <tbody></tbody>
    </table>
    <p class="err">${state.err}</p>
  </div>`);
  box.querySelector("#filter").onchange = (e) => {
    state.sealFilter = e.target.value;
    render();
  };
  const tbody = box.querySelector("tbody");
  const shown = state.sealFilter
    ? state.seals.filter((s) => String(s.workshopId) === state.sealFilter)
    : state.seals;
  shown.forEach((s) => {
    const tr = el(`<tr>
      <td>${s.workshop}<span class="hint"> · ${s.alley}</span></td>
      <td class="${sealClass(s.raised)}">${sealLabel(s.raised)}</td>
      <td>${s.changedBy ?? "—"}</td>
      <td>${fmtTime(s.changedAt)}</td>
      ${isAdmin ? `<td class="ops"></td>` : ""}
    </tr>`);
    if (isAdmin) {
      const ops = tr.querySelector(".ops");
      const act = (raised, text) => {
        const b = el(`<button>${text}</button>`);
        b.onclick = async () => {
          state.err = "";
          try {
            await api(`/api/seals/${s.workshopId}`, { method: "PUT", body: JSON.stringify({ raised }) });
            await loadSeals();
          } catch (ex) {
            state.err = ex.message;
            render();
          }
        };
        ops.append(b);
      };
      if (s.raised !== true) act(true, "升旗");
      if (s.raised !== false) act(false, "降旗");
    }
    tbody.append(tr);
  });
  app.append(box);
}

function render() {
  app.innerHTML = "";
  if (!state.ready) {
    renderLogin();
    return;
  }
  renderNav();
  if (state.view === "seals") renderSeals();
  else renderBoard();
}

async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.role = me.role;
    state.username = me.username;
    await refresh();
  } catch (e) {
    localStorage.removeItem(TOKEN_KEY);
    state.ready = false;
    state.err = e.message;
    render();
  }
}

if (state.ready) {
  boot();
} else {
  render();
}
