const $ = (sel) => document.querySelector(sel);

const state = {
  channels: [],
};

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function fmtTs(ts) {
  const n = parseFloat(ts);
  if (!Number.isFinite(n)) return ts;
  return new Date(n * 1000).toLocaleString();
}

async function refreshChannels() {
  const { channels } = await api("/channels");
  state.channels = channels;

  const tbody = $("#channels-table tbody");
  tbody.innerHTML = "";
  for (const c of channels) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>#${c.name}${c.is_private ? " <span class='hint'>(private)</span>" : ""}</td>
      <td class="${c.enabled ? "status-on" : "status-off"}">${c.enabled ? "on" : "off"}</td>
      <td>${c.message_count.toLocaleString()}</td>
      <td>${c.last_message_ts ? fmtTs(c.last_message_ts) : "never"}</td>
      <td class="actions">
        <button data-act="toggle" data-id="${c.slack_id}" data-enabled="${c.enabled ? 1 : 0}">
          ${c.enabled ? "Pause" : "Resume"}
        </button>
        <button data-act="extract" data-id="${c.slack_id}">Extract</button>
        <a href="/api/channels/${c.slack_id}/export?format=jsonl">JSONL</a>
        <a href="/api/channels/${c.slack_id}/export?format=csv">CSV</a>
        <a href="/api/channels/${c.slack_id}/export?format=txt">TXT</a>
        <button data-act="delete" data-id="${c.slack_id}" data-name="${c.name}" class="danger">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Populate channel selects
  for (const sel of [$("#search-channel"), $("#browse-channel")]) {
    const current = sel.value;
    sel.innerHTML = sel === $("#search-channel")
      ? '<option value="">all channels</option>'
      : '<option value="">pick a channel</option>';
    for (const c of channels) {
      const opt = document.createElement("option");
      opt.value = c.slack_id;
      opt.textContent = `#${c.name}`;
      sel.appendChild(opt);
    }
    sel.value = current;
  }
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ref = $("#add-input").value.trim();
  if (!ref) return;
  try {
    const r = await api("/channels", {
      method: "POST",
      body: JSON.stringify({ channel: ref }),
    });
    toast(`Added #${r.channel.name}`);
    $("#add-input").value = "";
    await refreshChannels();
  } catch (err) { toast(err.message, "err"); }
});

$("#tick-now").addEventListener("click", async () => {
  try {
    await api("/scheduler/tick", { method: "POST" });
    toast("Extraction triggered");
    setTimeout(refreshChannels, 1500);
  } catch (err) { toast(err.message, "err"); }
});

$("#channels-table").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  try {
    if (act === "delete") {
      if (!confirm(`Remove #${btn.dataset.name} and all archived messages?`)) return;
      await api(`/channels/${id}`, { method: "DELETE" });
      toast("Removed");
    } else if (act === "toggle") {
      const enabled = btn.dataset.enabled === "1";
      await api(`/channels/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !enabled }),
      });
      toast(enabled ? "Paused" : "Resumed");
    } else if (act === "extract") {
      btn.disabled = true;
      btn.textContent = "Extracting…";
      await api(`/channels/${id}/extract`, { method: "POST" });
      toast("Extracted");
    }
    await refreshChannels();
  } catch (err) { toast(err.message, "err"); }
});

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  const channel = $("#search-channel").value;
  try {
    const r = await api(`/search?q=${encodeURIComponent(q)}${channel ? `&channel=${channel}` : ""}`);
    const ol = $("#search-results");
    ol.innerHTML = "";
    if (r.results.length === 0) { ol.innerHTML = "<li class='hint'>no matches</li>"; return; }
    for (const m of r.results) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="msg-meta">
          <span class="channel-tag">#${m.channel_name}</span>
          ${m.user_name ?? m.user_id ?? "unknown"} · ${fmtTs(m.slack_ts)}
        </div>
        <div class="msg-text"></div>
      `;
      li.querySelector(".msg-text").textContent = m.text;
      ol.appendChild(li);
    }
  } catch (err) { toast(err.message, "err"); }
});

$("#browse-load").addEventListener("click", async () => {
  const channel = $("#browse-channel").value;
  if (!channel) { toast("pick a channel", "err"); return; }
  try {
    const total = state.channels.find((c) => c.slack_id === channel)?.message_count || 0;
    const offset = Math.max(0, total - 100);
    const r = await api(`/channels/${channel}/messages?limit=100&offset=${offset}`);
    const ol = $("#browse-results");
    ol.innerHTML = "";
    if (r.messages.length === 0) { ol.innerHTML = "<li class='hint'>no messages yet</li>"; return; }
    for (const m of r.messages) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="msg-meta">${m.user_name ?? m.user_id ?? "unknown"} · ${fmtTs(m.slack_ts)}</div>
        <div class="msg-text"></div>
      `;
      li.querySelector(".msg-text").textContent = m.text;
      ol.appendChild(li);
    }
  } catch (err) { toast(err.message, "err"); }
});

async function refreshStatus() {
  try {
    const s = await api("/setup/status");
    const banner = $("#status-banner");
    if (s.status.state === "ready") {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.className = s.status.state === "not_owner" || s.status.state === "error" ? "banner err" : "banner warn";
    const link = '<a href="/setup.html">Open setup wizard</a>';
    banner.innerHTML = `${s.status.message} — ${link}`;
  } catch {
    /* ignore */
  }
}

refreshChannels().catch((err) => toast(err.message, "err"));
refreshStatus();
setInterval(() => { refreshChannels().catch(() => {}); refreshStatus(); }, 30_000);
