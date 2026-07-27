/* AutoBugFixer 控制台（原生 JS，hash 路由单页应用）
 * 视图：#/board 看板、#/task/{id} 任务详情、#/interventions 介入待办、#/experience 经验库
 * 所有数据来自 /api/**，字段以真实接口为准，缺失字段做防御式渲染。
 */
"use strict";

// ---------- 基础工具 ----------

const app = document.getElementById("app");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, options = {}) {
  const resp = await fetch("/api" + path, options);
  if (!resp.ok) {
    let msg = resp.statusText;
    try { msg = (await resp.json()).detail || msg; } catch (e) { /* 非 JSON 响应 */ }
    throw new Error(`请求失败(${resp.status}): ${msg}`);
  }
  return resp.json();
}

function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 4000);
}

function fmtTime(s) {
  if (!s) return "-";
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString("zh-CN", { hour12: false });
}

function pct(v) { return ((v || 0) * 100).toFixed(1) + "%"; }

// ---------- 状态与类型字典 ----------

const STATE_LABELS = {
  DISCOVERED: "已发现", ANALYZING: "分析中", WAIT_INFO: "待补充信息",
  PLANNING: "方案生成中", WAIT_PLAN: "待方案确认", SCORED: "已入队",
  MANUAL: "转人工", FIXING: "修复中", DEPLOYING: "部署中",
  WAIT_ENV: "等待环境", VERIFYING: "验证中", LEARNING: "经验沉淀",
  WAIT_DISCUSS: "待失败讨论", CLOSED: "已关闭", FAILED: "失败", CANCELLED: "已取消",
};
const STATE_CLASS = {
  CLOSED: "ok", FAILED: "bad", MANUAL: "warn", CANCELLED: "mute",
  WAIT_INFO: "wait", WAIT_PLAN: "wait", WAIT_ENV: "wait", WAIT_DISCUSS: "wait",
};
// 需要突出显示（告警）的状态
const ALERT_STATES = new Set(["FAILED", "WAIT_INFO", "WAIT_PLAN", "WAIT_ENV", "WAIT_DISCUSS", "MANUAL"]);

const INTERV_TYPES = {
  info_supplement: "信息补充", plan_confirm: "方案确认",
  discussion: "失败讨论", optimization: "优化建议",
};
const ROLE_LABELS = { tester: "测试", tech_lead: "技术负责人", developer: "开发" };

function stateBadge(state) {
  const cls = STATE_CLASS[state] || "run";
  return `<span class="badge badge-${cls}">${esc(STATE_LABELS[state] || state)}</span>`;
}

function riskBadge(level) {
  const labels = { high: "高风险", medium: "中风险", low: "低风险" };
  const cls = ["high", "medium", "low"].includes(level) ? level : "low";
  return `<span class="badge badge-risk-${cls}">${esc(labels[level] || level || "-")}</span>`;
}

// ---------- 路由 ----------

function route() {
  const hash = location.hash || "#/board";
  const parts = hash.replace(/^#\//, "").split("/");
  document.querySelectorAll(".nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.nav === parts[0] ||
      (parts[0] === "task" && a.dataset.nav === "board"));
  });
  if (parts[0] === "task" && parts[1]) renderTaskDetail(Number(parts[1]));
  else if (parts[0] === "interventions") renderInterventions();
  else if (parts[0] === "experience") renderExperience();
  else renderBoard();
}

window.addEventListener("hashchange", route);

// ---------- 看板 ----------

async function renderBoard(stateFilter = "") {
  app.innerHTML = `<div class="metrics" id="metrics"></div>
    <div class="card">
      <div class="toolbar">
        <h3 style="margin:0">任务列表</h3>
        <span class="spacer"></span>
        <label class="muted">状态筛选</label>
        <select id="state-filter">
          <option value="">全部</option>
          ${Object.entries(STATE_LABELS).map(([k, v]) =>
            `<option value="${k}" ${k === stateFilter ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <button class="btn" id="btn-refresh">刷新</button>
      </div>
      <div id="task-table"><p class="muted">加载中…</p></div>
    </div>`;

  document.getElementById("state-filter").addEventListener("change", e => renderBoard(e.target.value));
  document.getElementById("btn-refresh").addEventListener("click", () => renderBoard(stateFilter));

  // 指标卡：字段以 /api/metrics/summary 实际返回为准
  try {
    const m = await api("/metrics/summary");
    document.getElementById("metrics").innerHTML = [
      ["自动修复成功率", pct(m.auto_fix_rate)],
      ["首次回归通过率", pct(m.first_verify_pass_rate)],
      ["任务总数", m.tasks_total ?? 0],
    ].map(([label, value]) =>
      `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>`
    ).join("");
  } catch (e) {
    document.getElementById("metrics").innerHTML = `<div class="metric"><div class="label">指标加载失败</div><div class="value">-</div></div>`;
  }

  try {
    const data = await api("/tasks?size=100" + (stateFilter ? `&state=${stateFilter}` : ""));
    const rows = data.items.map(t => `
      <tr class="${ALERT_STATES.has(t.state) ? "row-alert" : ""}" data-id="${t.id}">
        <td>${t.id}</td>
        <td>${esc(t.bug_ticket_id)}</td>
        <td>${esc(t.title ?? "—")}</td>
        <td>${stateBadge(t.state)}</td>
        <td>${t.priority_score ?? "-"}</td>
        <td>${t.retry_count}</td>
        <td class="muted">${esc(t.current_stage || "-")}</td>
        <td class="muted">${fmtTime(t.updated_at || t.created_at)}</td>
      </tr>`).join("");
    document.getElementById("task-table").innerHTML = `
      <table class="grid">
        <thead><tr>
          <th>ID</th><th>Bug 单</th><th>标题</th><th>状态</th>
          <th>综合分</th><th>重试</th><th>当前阶段</th><th>更新时间</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="empty">暂无任务</td></tr>`}</tbody>
      </table>
      <p class="muted" style="margin:8px 0 0">共 ${data.total} 个任务，点击行查看详情</p>`;
    document.querySelectorAll("#task-table tbody tr[data-id]").forEach(tr => {
      tr.addEventListener("click", () => { location.hash = `#/task/${tr.dataset.id}`; });
    });
  } catch (e) {
    document.getElementById("task-table").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

// ---------- 任务详情 ----------

async function renderTaskDetail(taskId) {
  app.innerHTML = `<p class="muted">加载中…</p>`;
  let t;
  try {
    t = await api(`/tasks/${taskId}`);
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p>
      <p><a href="#/board">← 返回看板</a></p></div>`;
    return;
  }

  const alert = ALERT_STATES.has(t.state);
  const canRetry = ["FAILED", "WAIT_ENV", "MANUAL"].includes(t.state);
  const sd = t.score_detail || {};

  app.innerHTML = `
    <div class="card ${alert ? "row-alert" : ""}">
      <div class="detail-head">
        <h2>任务 #${t.id}</h2>
        ${stateBadge(t.state)}
        <span class="muted">Bug 单 ${esc(t.bug_ticket_id)}</span>
        <span class="spacer" style="flex:1"></span>
        ${canRetry ? `<button class="btn btn-primary" id="btn-retry">重新触发</button>` : ""}
        <a class="btn" href="#/board">返回看板</a>
      </div>
      <dl class="kv" style="margin-top:12px">
        <dt>综合分</dt><dd>${t.priority_score ?? "-"}</dd>
        <dt>重试次数</dt><dd>${t.retry_count}</dd>
        <dt>当前阶段</dt><dd>${esc(t.current_stage || "-")}</dd>
        <dt>创建时间</dt><dd>${fmtTime(t.created_at)}</dd>
      </dl>
    </div>

    <h3 class="section-title">三维评分与准入结论</h3>
    <div class="card" id="score-card">${renderScore(sd, t.priority_score)}</div>

    <h3 class="section-title">状态时间线</h3>
    <div class="card">${renderTimeline(t.timeline)}</div>

    <h3 class="section-title">验证方案</h3>
    <div class="card">${renderPlans(t.plans)}</div>

    <h3 class="section-title">修复记录</h3>
    <div class="card">${renderFixes(t.fix_records)}</div>

    <h3 class="section-title">验证结论与证据</h3>
    <div class="card">${renderVerifies(t.verify_records)}</div>`;

  if (canRetry) {
    document.getElementById("btn-retry").addEventListener("click", async ev => {
      const btn = ev.target;
      btn.disabled = true;
      btn.textContent = "触发中…";
      try {
        const r = await api(`/tasks/${taskId}/retry`, { method: "POST" });
        toast(`已重新触发，当前状态: ${STATE_LABELS[r.state] || r.state}`);
        renderTaskDetail(taskId);
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = "重新触发";
      }
    });
  }
}

function renderScore(sd, total) {
  if (!sd || !Object.keys(sd).length) return `<p class="muted">尚未评分</p>`;
  const dims = [
    ["修复难度", sd.fix_difficulty],
    ["验证难度", sd.verify_difficulty],
    ["变更规模", sd.change_scale],
  ];
  const bars = dims.map(([name, v]) => `
    <div class="score-row">
      <span class="name">${name}</span>
      <div class="score-bar"><i style="width:${Math.min(100, (v || 0) * 10)}%"></i></div>
      <span class="num">${v ?? "-"}</span>
    </div>`).join("");
  const w = sd.weights || {};
  const admitted = total != null && sd.threshold != null ? total < sd.threshold : null;
  return `${bars}
    <dl class="kv" style="margin-top:10px">
      <dt>综合分</dt><dd><strong>${total ?? "-"}</strong>（权重 修复=${w.fix ?? "-"} / 验证=${w.verify ?? "-"} / 规模=${w.change ?? "-"}${w.version ? `，版本 ${esc(w.version)}` : ""}）</dd>
      <dt>准入阈值</dt><dd>${sd.threshold ?? "-"}</dd>
      <dt>准入结论</dt><dd>${admitted == null ? "-" : admitted
        ? '<span class="badge badge-ok">准入自动修复</span>'
        : '<span class="badge badge-warn">超阈值，转人工</span>'}</dd>
      <dt>评分理由</dt><dd>${esc(sd.rationale || "-")}</dd>
    </dl>`;
}

function renderTimeline(timeline) {
  if (!timeline || !timeline.length) return `<p class="muted">暂无状态记录</p>`;
  const items = timeline.map(h => {
    const cls = h.to === "FAILED" ? "tl-bad" : h.to === "CLOSED" ? "tl-ok"
      : h.to.startsWith("WAIT") ? "tl-wait" : "";
    return `<li class="${cls}">
      ${h.from ? `${esc(STATE_LABELS[h.from] || h.from)} → ` : ""}<strong>${esc(STATE_LABELS[h.to] || h.to)}</strong>
      <span class="tl-time">${fmtTime(h.at)}</span>
      ${h.message ? `<div class="muted">${esc(h.message)}</div>` : ""}
    </li>`;
  }).join("");
  return `<ul class="timeline">${items}</ul>`;
}

// DSL 动作的可读渲染
const ACTION_LABELS = {
  open_page: "打开页面", click: "点击", input: "输入",
  assert_element: "断言元素", call_api: "调用接口", assert_response: "断言响应",
  query_db: "查询数据库", assert_db: "断言数据库", check_log: "检查日志",
};

function renderSteps(steps) {
  if (!steps || !steps.length) return `<p class="muted">无步骤</p>`;
  return `<ol class="steps">${steps.map(s => {
    const params = Object.entries(s.params || {})
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
    return `<li><code>${esc(ACTION_LABELS[s.action] || s.action)}</code> ${esc(params)}` +
      (s.desc ? `<div class="muted">${esc(s.desc)}</div>` : "") + `</li>`;
  }).join("")}</ol>`;
}

function renderPlans(plans) {
  if (!plans || !plans.length) return `<p class="muted">暂无验证方案</p>`;
  return plans.map(p => `
    <div style="margin-bottom:14px">
      <div style="margin-bottom:6px">版本 v${p.version} ${riskBadge(p.risk_level)}</div>
      ${renderSteps(p.steps)}
    </div>`).join("");
}

function renderFixes(fixes) {
  if (!fixes || !fixes.length) return `<p class="muted">暂无修复记录</p>`;
  return fixes.map(f => `
    <div style="margin-bottom:14px">
      <dl class="kv">
        <dt>第 ${f.attempt} 次尝试</dt><dd>${f.branch ? `分支 <code>${esc(f.branch)}</code>` : ""}</dd>
        <dt>变更文件</dt><dd>${(f.changed_files || []).length
          ? f.changed_files.map(x => `<code>${esc(x)}</code>`).join("、") : "-"}</dd>
        <dt>修复说明</dt><dd>${esc(f.summary || "-")}</dd>
      </dl>
    </div>`).join("");
}

function renderVerifies(verifies) {
  if (!verifies || !verifies.length) return `<p class="muted">暂无验证记录</p>`;
  return verifies.map(v => {
    const ok = v.conclusion === "passed";
    const steps = (v.step_results || []).map(s => `
      <li>${s.passed ? "✅" : "❌"} <code>${esc(s.action)}</code> ${esc(s.detail || "")}
        ${s.evidence ? `<div class="muted">证据: ${esc(s.evidence)}</div>` : ""}</li>`).join("");
    return `<div style="margin-bottom:14px">
      <div>第 ${v.attempt} 次验证:
        <span class="badge badge-${ok ? "ok" : "bad"}">${ok ? "通过" : "未通过"}</span></div>
      ${steps ? `<ol class="steps" style="margin-top:6px">${steps}</ol>` : ""}
    </div>`;
  }).join("");
}

// ---------- 介入待办 ----------

async function renderInterventions() {
  app.innerHTML = `<div class="card"><h3>待处理介入单</h3><div id="interv-list"><p class="muted">加载中…</p></div></div>`;
  let items;
  try {
    items = (await api("/interventions?status=pending")).items;
  } catch (e) {
    document.getElementById("interv-list").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  updatePendingBadge(items.length);
  if (!items.length) {
    document.getElementById("interv-list").innerHTML = `<p class="empty">暂无待处理介入单</p>`;
    return;
  }
  document.getElementById("interv-list").innerHTML = items.map(i => {
    const overdue = i.deadline && new Date(i.deadline) < new Date();
    return `<div class="interv-item card" style="margin-bottom:10px">
      <span class="badge badge-wait">${esc(INTERV_TYPES[i.type] || i.type)}</span>
      <div class="grow">
        <div class="title">${esc(i.title)}</div>
        <div class="meta">
          介入单 #${i.id} · 角色: ${esc(ROLE_LABELS[i.assignee_role] || i.assignee_role)}
          ${i.deadline ? ` · <span class="${overdue ? "overdue" : ""}">截止: ${fmtTime(i.deadline)}${overdue ? "（已超时）" : ""}</span>` : ""}
        </div>
      </div>
      <a class="btn" href="#/task/${i.task_id}">任务 #${i.task_id}</a>
      <button class="btn btn-primary" data-id="${i.id}">处理</button>
    </div>`;
  }).join("");
  document.querySelectorAll("#interv-list button[data-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = items.find(x => x.id === Number(btn.dataset.id));
      openInterventionModal(item);
    });
  });
}

function updatePendingBadge(n) {
  const badge = document.getElementById("nav-pending");
  badge.hidden = !n;
  badge.textContent = n;
}

// 介入处理弹窗：按类型渲染表单
function openInterventionModal(item) {
  const modal = document.getElementById("modal");
  const body = document.getElementById("modal-body");
  document.getElementById("modal-title").textContent =
    `${INTERV_TYPES[item.type] || item.type} — ${item.title}`;

  const ctxHtml = `<details style="margin-bottom:10px">
      <summary>上下文 payload</summary>
      <pre class="block">${esc(JSON.stringify(item.context || {}, null, 2))}</pre>
    </details>`;

  if (item.type === "info_supplement") {
    // 信息补充：按缺失字段逐个生成文本域
    const missing = (item.context && item.context.missing_fields) || [];
    const fields = missing.length ? missing : ["repro_steps", "expected", "actual", "env_version"];
    const suggestions = ((item.context && item.context.suggestions) || [])
      .map(s => `<li>${esc(s)}</li>`).join("");
    body.innerHTML = `${ctxHtml}
      ${suggestions ? `<div class="form-row"><label>补充建议</label><ul>${suggestions}</ul></div>` : ""}
      ${fields.map(f => `<div class="form-row">
        <label>${esc(f)}</label><textarea rows="2" data-field="${esc(f)}"></textarea>
      </div>`).join("")}
      <div class="form-actions"><button class="btn btn-primary" id="m-submit">提交补充</button></div>`;
    body.querySelector("#m-submit").addEventListener("click", async () => {
      const result = { fields: {} };
      body.querySelectorAll("textarea[data-field]").forEach(ta => {
        if (ta.value.trim()) result.fields[ta.dataset.field] = ta.value.trim();
      });
      if (!Object.keys(result.fields).length) { toast("请至少填写一个字段", true); return; }
      await submitIntervention(item.id, result);
    });
  } else if (item.type === "plan_confirm") {
    // 方案确认：确认通过（可附带调整后的步骤 JSON）或驳回转人工
    const stepsJson = JSON.stringify((item.context && item.context.steps) || [], null, 2);
    body.innerHTML = `${ctxHtml}
      <div class="form-row"><label>验证步骤（可调整，JSON 数组）</label>
        <textarea rows="10" id="m-steps">${esc(stepsJson)}</textarea></div>
      <div class="form-actions">
        <button class="btn btn-danger" id="m-reject">驳回（转人工）</button>
        <button class="btn btn-primary" id="m-approve">确认方案</button>
      </div>`;
    body.querySelector("#m-approve").addEventListener("click", async () => {
      let steps;
      try { steps = JSON.parse(body.querySelector("#m-steps").value); }
      catch (e) { toast("步骤 JSON 解析失败: " + e.message, true); return; }
      await submitIntervention(item.id, { approved: true, steps });
    });
    body.querySelector("#m-reject").addEventListener("click", () =>
      submitIntervention(item.id, { approved: false }));
  } else if (item.type === "discussion") {
    // 失败讨论：意见 + 处理决定
    body.innerHTML = `${ctxHtml}
      <div class="form-row"><label>讨论意见</label><textarea rows="4" id="m-opinion"></textarea></div>
      <div class="form-row"><label>处理决定</label>
        <select id="m-action">
          <option value="manual_fix">人工接手修复</option>
          <option value="retry">再次自动重试</option>
          <option value="close">关闭任务</option>
        </select></div>
      <div class="form-actions"><button class="btn btn-primary" id="m-submit">提交决定</button></div>`;
    body.querySelector("#m-submit").addEventListener("click", async () => {
      const result = {
        action: body.querySelector("#m-action").value,
        opinion: body.querySelector("#m-opinion").value.trim(),
      };
      await submitIntervention(item.id, result);
    });
  } else {
    // optimization 等其它类型：仅回写备注
    body.innerHTML = `${ctxHtml}
      <div class="form-row"><label>处理备注</label><textarea rows="4" id="m-note"></textarea></div>
      <div class="form-actions"><button class="btn btn-primary" id="m-submit">提交</button></div>`;
    body.querySelector("#m-submit").addEventListener("click", () =>
      submitIntervention(item.id, { note: body.querySelector("#m-note").value.trim() }));
  }
  modal.hidden = false;
}

async function submitIntervention(id, result) {
  try {
    const r = await api(`/interventions/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, actor: "web-console" }),
    });
    document.getElementById("modal").hidden = true;
    toast(`已回写，任务 #${r.task_id} 当前状态: ${STATE_LABELS[r.task_state] || r.task_state}`);
    renderInterventions();
  } catch (e) {
    toast(e.message, true);
  }
}

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("modal").hidden = true;
});
document.getElementById("modal").addEventListener("click", e => {
  if (e.target.id === "modal") e.target.hidden = true;
});

// ---------- 经验库 ----------

async function renderExperience(category = "", q = "") {
  app.innerHTML = `<div class="card">
      <div class="toolbar">
        <h3 style="margin:0">经验库</h3>
        <span class="spacer"></span>
        <select id="exp-cat"><option value="">全部分类</option></select>
        <input type="text" id="exp-q" placeholder="关键词（问题特征）" value="${esc(q)}">
        <button class="btn" id="exp-search">搜索</button>
      </div>
    </div>
    <div class="exp-grid" id="exp-list"><p class="muted">加载中…</p></div>`;

  const doSearch = () => renderExperience(
    document.getElementById("exp-cat").value,
    document.getElementById("exp-q").value.trim());
  document.getElementById("exp-search").addEventListener("click", doSearch);
  document.getElementById("exp-q").addEventListener("keydown", e => {
    if (e.key === "Enter") doSearch();
  });
  document.getElementById("exp-cat").addEventListener("change", doSearch);

  let items;
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    items = (await api("/experiences" + (params.size ? `?${params}` : ""))).items;
  } catch (e) {
    document.getElementById("exp-list").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }

  // 分类下拉来自当前结果集（接口无单独分类枚举）
  const cats = [...new Set(items.map(i => i.category).filter(Boolean))].sort();
  document.getElementById("exp-cat").innerHTML =
    `<option value="">全部分类</option>` +
    cats.map(c => `<option value="${esc(c)}" ${c === category ? "selected" : ""}>${esc(c)}</option>`).join("");

  if (!items.length) {
    document.getElementById("exp-list").innerHTML = `<p class="empty" style="grid-column:1/-1">暂无经验条目</p>`;
    return;
  }
  document.getElementById("exp-list").innerHTML = items.map(e => `
    <div class="card exp-card" style="margin:0">
      <div class="sig">${esc(e.problem_signature)}</div>
      <div class="field"><span class="k">分类</span><br>${esc(e.category || "-")}</div>
      <div class="field"><span class="k">修复方法</span><br>${esc(e.fix_pattern || "-")}</div>
      <div class="field"><span class="k">验证要点</span><br>${esc(e.verification_points ?? "—")}</div>
      <div class="field"><span class="k">适用条件</span><br>${esc(e.applicable_conditions ?? "—")}</div>
      <div class="hit">命中 ${e.hit_count ?? 0} 次</div>
    </div>`).join("");
}

// ---------- CSV 导入 ----------

document.getElementById("btn-import").addEventListener("click", () => {
  document.getElementById("csv-file").click();
});

document.getElementById("csv-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("run_analysis", document.getElementById("csv-analysis").checked ? "true" : "false");
  try {
    const r = await api("/import/csv", { method: "POST", body: fd });
    let msg = `导入完成: 共 ${r.total} 行，新增 ${r.imported}，跳过 ${r.skipped}，失败 ${(r.failed || []).length}`;
    if ((r.failed || []).length) {
      msg += "\n" + r.failed.map(f => `第 ${f.row} 行: ${f.reason}`).join("\n");
    }
    if (r.analysis) {
      msg += "\n预处理分析: " + r.analysis.map(a =>
        `#${a.task_id} ${a.admission}`).join("，");
    }
    toast(msg);
    if ((location.hash || "#/board").startsWith("#/board")) renderBoard();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- 启动 ----------

// 导航上的待处理数徽标
api("/interventions?status=pending")
  .then(d => updatePendingBadge(d.items.length))
  .catch(() => { /* 启动时静默失败 */ });

route();
