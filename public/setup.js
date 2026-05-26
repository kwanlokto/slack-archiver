const $ = (sel) => document.querySelector(sel);

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function renderStatus(s) {
  const box = $("#status-box");
  box.className = "status-box";
  switch (s.status.state) {
    case "ready":
      box.classList.add("ok");
      box.innerHTML = `<strong>Connected.</strong> Archiving as @${s.user_name ?? s.status.user} in <em>${s.team ?? s.status.team}</em>.`;
      $("#disconnect").hidden = false;
      $("#open-admin").hidden = false;
      break;
    case "not_owner":
      box.classList.add("err");
      box.textContent = `Signed in as @${s.status.user} in ${s.status.team} — but that user is not a workspace owner. Paste a token from an owner account.`;
      $("#disconnect").hidden = false;
      break;
    case "error":
      box.classList.add("err");
      box.textContent = `Error: ${s.status.message}`;
      $("#disconnect").hidden = false;
      break;
    case "unconfigured":
    default:
      box.classList.add("warn");
      box.textContent = "No token yet. Paste one below to connect.";
      break;
  }
  const scopeList = $("#scope-list");
  scopeList.innerHTML = "";
  for (const sc of s.required_scopes) {
    const li = document.createElement("li");
    li.innerHTML = `<code>${sc}</code>`;
    scopeList.appendChild(li);
  }
}

async function loadStatus() {
  try {
    const s = await api("/api/setup/status");
    renderStatus(s);
  } catch (err) {
    toast(err.message, "err");
  }
}

$("#token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("#token-input").value.trim();
  if (!token) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    await api("/api/setup/token", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    toast("Connected");
    $("#token-input").value = "";
    await loadStatus();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
});

$("#disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect from Slack? Archived messages stay, but you'll need a new token to resume archiving.")) return;
  try {
    await api("/api/setup/disconnect", { method: "POST" });
    toast("Disconnected");
    $("#disconnect").hidden = true;
    $("#open-admin").hidden = true;
    await loadStatus();
  } catch (err) {
    toast(err.message, "err");
  }
});

loadStatus();
