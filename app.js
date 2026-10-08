/* AntifieldCloud P6 UI prototype interactions */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let busy = false;
  let elapsedTimer = 0;
  let startedAt = 0;

  const viewTitles = {
    console: "控制台",
    ai: "AI 会话",
    eff: "效率",
    jobs: "流水线",
    portal: "门户",
  };

  function escapeHtml(s) {
    const amp = String.fromCharCode(38);
    return String(s)
      .replace(/&/g, amp + "amp;")
      .replace(/</g, amp + "lt;")
      .replace(/>/g, amp + "gt;")
      .replace(/"/g, amp + "quot;");
  }

  function toast(msg, kind = "ok") {
    const root = $("#toast-root");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .2s";
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      const modal = $("#modal");
      $("#modal-title").textContent = title;
      $("#modal-body").textContent = body;
      modal.hidden = false;
      const ok = $("#modal-ok");
      const cancel = $("#modal-cancel");
      const done = (v) => {
        modal.hidden = true;
        ok.onclick = null;
        cancel.onclick = null;
        resolve(v);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
    });
  }

  function showLogin() {
    $("#login-view").hidden = false;
    $("#app-view").style.display = "none";
    $("#login-pw").focus();
  }

  function showApp() {
    $("#login-view").hidden = true;
    $("#app-view").style.display = "";
    switchView(location.hash.replace("#", "") || "console");
  }

  $("#login-btn").addEventListener("click", () => {
    if ($("#login-pw").value.length < 1) {
      $("#login-err").hidden = false;
      return;
    }
    $("#login-err").hidden = true;
    toast("已进入工作台");
    showApp();
  });

  $("#login-pw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#login-btn").click();
  });

  $("#btn-logout").addEventListener("click", async () => {
    if (!(await confirmDialog("退出登录", "将清除本机会话 cookie。"))) return;
    toast("已退出");
    showLogin();
  });

  $("#btn-pw").addEventListener("click", () => {
    $("#pw-modal").hidden = false;
    $("#pw-old").focus();
  });
  $("#pw-cancel").addEventListener("click", () => {
    $("#pw-modal").hidden = true;
  });
  $("#pw-ok").addEventListener("click", () => {
    const oldPw = $("#pw-old").value;
    const newPw = $("#pw-new").value;
    if (newPw.length < 8) {
      $("#pw-err").hidden = false;
      $("#pw-err").textContent = "新口令至少 8 位";
      return;
    }
    if (!oldPw) {
      $("#pw-err").hidden = false;
      $("#pw-err").textContent = "请输入旧口令";
      return;
    }
    $("#pw-err").hidden = true;
    $("#pw-modal").hidden = true;
    $("#pw-old").value = "";
    $("#pw-new").value = "";
    toast("口令已更新，全部会话将失效");
  });

  function switchView(id) {
    if (!viewTitles[id]) id = "console";
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${id}`));
    $("#crumb-page").textContent = viewTitles[id];
    location.hash = id;
    $("#sidebar").classList.remove("open");
  }

  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  $("#btn-menu").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
  });

  const commands = [
    { kind: "跳转", label: "打开控制台", run: () => switchView("console") },
    { kind: "跳转", label: "打开 AI 会话", run: () => switchView("ai") },
    { kind: "跳转", label: "打开效率", run: () => switchView("eff") },
    { kind: "跳转", label: "打开流水线", run: () => switchView("jobs") },
    { kind: "跳转", label: "打开门户", run: () => switchView("portal") },
    {
      kind: "操作",
      label: "新建 AI 会话",
      run: () => {
        switchView("ai");
        $("#btn-new-session").click();
      },
    },
    {
      kind: "操作",
      label: "记一条待办",
      run: () => {
        switchView("eff");
        $("#todo-title").focus();
      },
    },
    {
      kind: "操作",
      label: "新建流水线任务",
      run: () => {
        switchView("jobs");
        $("#btn-new-job").click();
      },
    },
    { kind: "操作", label: "修改口令", run: () => $("#btn-pw").click() },
    { kind: "搜索", label: "搜索「备份」", run: () => toast("命中：待办 x1 · 会话 x1") },
    { kind: "搜索", label: "搜索「SD」", run: () => toast("命中：笔记《SD 写入基线》") },
  ];

  let cmdkIndex = 0;
  let cmdkFiltered = commands;

  function renderCmdk(q = "") {
    const list = $("#cmdk-list");
    const needle = q.trim().toLowerCase();
    cmdkFiltered = commands.filter(
      (c) => c.label.toLowerCase().includes(needle) || c.kind.includes(needle),
    );
    cmdkIndex = 0;
    list.innerHTML = cmdkFiltered
      .map(
        (c, i) =>
          `<li class="${i === 0 ? "selected" : ""}"><button data-i="${i}"><span class="cmd-kind">${c.kind}</span><span>${c.label}</span></button></li>`,
      )
      .join("");
    $$("#cmdk-list button").forEach((b) => {
      b.addEventListener("click", () => {
        const cmd = cmdkFiltered[Number(b.dataset.i)];
        closeCmdk();
        cmd.run();
      });
    });
  }

  function openCmdk() {
    $("#cmdk").hidden = false;
    $("#cmdk-input").value = "";
    renderCmdk();
    $("#cmdk-input").focus();
  }

  function closeCmdk() {
    $("#cmdk").hidden = true;
  }

  function moveCmdk(delta) {
    if (!cmdkFiltered.length) return;
    cmdkIndex = (cmdkIndex + delta + cmdkFiltered.length) % cmdkFiltered.length;
    $$("#cmdk-list li").forEach((li, i) => li.classList.toggle("selected", i === cmdkIndex));
  }

  $("#btn-cmdk").addEventListener("click", openCmdk);
  $("#btn-cmdk-top").addEventListener("click", openCmdk);
  $("#cmdk-input").addEventListener("input", (e) => renderCmdk(e.target.value));
  $("#cmdk").addEventListener("click", (e) => {
    if (e.target.id === "cmdk") closeCmdk();
  });

  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if ($("#cmdk").hidden) openCmdk();
      else closeCmdk();
      return;
    }
    if (e.key === "Escape") {
      closeCmdk();
      $("#modal").hidden = true;
      $("#pw-modal").hidden = true;
      return;
    }
    if (!$("#cmdk").hidden) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveCmdk(1);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveCmdk(-1);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = cmdkFiltered[cmdkIndex];
        if (cmd) {
          closeCmdk();
          cmd.run();
        }
      }
      return;
    }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const map = { "1": "console", "2": "ai", "3": "eff", "4": "jobs", "5": "portal" };
    if (map[e.key]) switchView(map[e.key]);
  });

  function lineChart(svg, data, color, gapMs = 15 * 60 * 1000) {
    if (!svg || data.length < 2) return;
    const W = 560;
    const H = 120;
    const vs = data.map((d) => d.v).filter((v) => v != null);
    if (!vs.length) return;
    const t0 = data[0].ts;
    const t1 = data[data.length - 1].ts;
    const span = Math.max(t1 - t0, 1);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const pad = (hi - lo || 1) * 0.1;
    const X = (t) => 20 + ((t - t0) / span) * (W - 30);
    const Y = (v) => H - 12 - ((v - lo + pad) / (hi - lo + pad * 2)) * (H - 28);
    let d = "";
    let prev = -Infinity;
    let pen = false;
    for (const p of data) {
      if (p.v == null || p.ts - prev > gapMs) {
        pen = false;
      } else {
        d += `${pen ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p.v).toFixed(1)}`;
        pen = true;
      }
      prev = p.ts;
    }
    svg.innerHTML =
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" />` +
      `<text x="4" y="12" font-size="9" fill="#5c6b78">${hi.toFixed(1)}</text>` +
      `<text x="4" y="${H - 4}" font-size="9" fill="#5c6b78">${lo.toFixed(1)}</text>`;
  }

  function mockSeries(n, base, amp) {
    const now = Date.now();
    const out = [];
    for (let i = n; i >= 0; i--) {
      out.push({
        ts: now - i * 10 * 60 * 1000,
        v: base + Math.sin(i / 3) * amp + (Math.random() - 0.5) * amp * 0.3,
      });
    }
    return out;
  }

  function drawCharts() {
    lineChart($("#chart-temp"), mockSeries(40, 48, 3), "#ff6b7a");
    lineChart($("#chart-cpu"), mockSeries(40, 12, 8), "#6cb6ff");
    lineChart($("#chart-mem"), mockSeries(40, 3.1, 0.4), "#5be9b9");
    lineChart($("#chart-sd"), mockSeries(40, 18, 1.2), "#b794f6");
  }

  $$("#range-seg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#range-seg .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      drawCharts();
      toast(`已切换到 ${btn.dataset.range} 视图`);
    });
  });

  $$("[data-restart]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const unit = btn.dataset.restart;
      const ok = await confirmDialog(
        "重启服务",
        `确认重启 ${unit}？自重启可能导致短暂断连。`,
      );
      if (!ok) return;
      toast(`${unit} 重启指令已下发`);
    });
  });

  $("#btn-copy-logs").addEventListener("click", async () => {
    const text = $$(".log-row")
      .map((r) => r.textContent.replace(/\s+/g, " ").trim())
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("日志已复制");
    } catch {
      toast("复制失败", "err");
    }
  });

  function setBusy(state) {
    busy = state;
    $("#btn-abort").hidden = !state;
    $("#btn-send").disabled = state;
    $("#ai-status").textContent = state ? "运行中" : "空闲";
    $("#ai-status").className = state ? "pill warn" : "pill ok";
    if (state) {
      startedAt = Date.now();
      elapsedTimer = setInterval(() => {
        $("#ai-elapsed").textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
      }, 400);
    } else {
      clearInterval(elapsedTimer);
    }
  }

  function bindSession(item) {
    item.addEventListener("click", () => {
      $$(".session-item").forEach((s) => s.classList.remove("active"));
      item.classList.add("active");
      $("#ai-title").textContent = item.querySelector(".s-title").textContent;
      $("#ai-sid").textContent = `${item.dataset.sid}... · text.delta`;
    });
  }
  $$(".session-item").forEach(bindSession);

  $("#btn-new-session").addEventListener("click", () => {
    const id = `ses_${Math.random().toString(36).slice(2, 6)}`;
    const el = document.createElement("button");
    el.className = "session-item active";
    el.dataset.sid = id;
    el.innerHTML = `<span class="s-title">新会话</span><span class="s-meta">刚刚</span>`;
    $$(".session-item").forEach((s) => s.classList.remove("active"));
    $("#session-list").prepend(el);
    bindSession(el);
    $("#ai-title").textContent = "新会话";
    $("#ai-sid").textContent = `${id}...`;
    toast("已创建会话");
    $("#ai-input").focus();
  });

  $("#btn-del-session").addEventListener("click", async () => {
    const ok = await confirmDialog("删除会话", "删除后不可恢复（含子会话）。");
    if (!ok) return;
    const active = $(".session-item.active");
    if (active) active.remove();
    toast("会话已删除");
  });

  function appendMsg(who, html, cls) {
    const t = $("#transcript");
    const div = document.createElement("div");
    div.className = `msg ${cls}`;
    div.innerHTML = `<div class="msg-who">${who}</div><div class="msg-body">${html}</div>`;
    t.appendChild(div);
    t.scrollTop = t.scrollHeight;
    return div.querySelector(".msg-body");
  }

  async function sendPrompt() {
    const input = $("#ai-input");
    const text = input.value.trim();
    if (!text || busy) return;
    appendMsg("你", escapeHtml(text), "user");
    input.value = "";
    setBusy(true);
    const bot = appendMsg("OpenCode", `<p>...</p><p class="msg-meta">text.delta</p>`, "bot");
    const lines = [
      "收到任务。正在对照仓库与文档…",
      "已扫描 docs/ 与 gateway/src/ 关键路径。",
      "结论：3 处文档表述需收口，已按代码事实列出差异。",
    ];
    let i = 0;
    const tick = setInterval(() => {
      if (i < lines.length) {
        const meta =
          i === lines.length - 1 ? "execution.succeeded · about 3s" : "text.delta...";
        bot.innerHTML = `<p>${lines[i]}</p><p class="msg-meta">${meta}</p>`;
        i += 1;
      } else {
        clearInterval(tick);
        setBusy(false);
        $("#ai-elapsed").textContent = "";
        toast("AI 任务完成");
      }
    }, 700);
  }

  $("#btn-send").addEventListener("click", sendPrompt);
  $("#ai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  $("#btn-abort").addEventListener("click", () => {
    setBusy(false);
    appendMsg("系统", "已中断（abort）", "bot");
    toast("已中断当前任务", "err");
  });

  $("#todo-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#todo-title").value.trim();
    if (!title) return;
    const due = $("#todo-due").value;
    const li = document.createElement("li");
    li.className = "todo";
    li.innerHTML = `
      <label class="check-box"><input type="checkbox" /><span></span></label>
      <div class="todo-body">
        <div class="todo-title">${escapeHtml(title)}</div>
        <div class="todo-meta">${due ? escapeHtml(due) : "无期限"}</div>
      </div>
      <button class="icon-btn" title="删除">x</button>`;
    $("#todo-list").prepend(li);
    bindTodo(li);
    $("#todo-title").value = "";
    $("#todo-due").value = "";
    updateTodoCount();
    toast("待办已添加");
  });

  function bindTodo(li) {
    const cb = li.querySelector("input");
    cb.addEventListener("change", () => {
      li.classList.toggle("done", cb.checked);
    });
    li.querySelector(".icon-btn").addEventListener("click", () => {
      li.remove();
      updateTodoCount();
      toast("待办已删除");
    });
  }

  function updateTodoCount() {
    $("#todo-count").textContent = String($$("#todo-list .todo").length);
  }

  $$("#todo-list .todo").forEach(bindTodo);

  $("#note-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#note-title").value.trim();
    const body = $("#note-body").value.trim();
    if (!title) return;
    const det = document.createElement("details");
    det.className = "note-item";
    det.open = true;
    const bodyHtml = escapeHtml(body || "(empty)").replace(/\n/g, "<br>");
    det.innerHTML = `<summary>${escapeHtml(title)}</summary><div class="md"><p>${bodyHtml}</p></div>`;
    $("#note-list").prepend(det);
    $("#note-title").value = "";
    $("#note-body").value = "";
    toast("笔记已保存");
  });

  $("#btn-export").addEventListener("click", () => toast("已开始导出 workbench.json"));
  $("#btn-import").addEventListener("click", () => toast("请选择 JSON 文件（合并/替换）"));
  $("#file-input").addEventListener("change", () => toast("文件已加入上传队列"));

  $$("[data-run-job]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog(
        "执行任务",
        "shell 任务将在网关主机（workbench 身份）上运行。确认执行？",
      );
      if (!ok) return;
      toast("任务已触发，写入 job_runs");
    });
  });

  $("#btn-new-job").addEventListener("click", () => {
    toast("新建任务面板：名称 / cron / kind / payload");
  });

  $$(".job-item").forEach((item) => {
    item.addEventListener("click", () => {
      $$(".job-item").forEach((j) => j.classList.remove("active"));
      item.classList.add("active");
      $("#runs-for").textContent = item.querySelector(".job-name").textContent;
    });
  });

  drawCharts();
  updateTodoCount();
  const q = new URLSearchParams(location.search);
  if (q.get("login") === "1") showLogin();
  else showApp();
})();
