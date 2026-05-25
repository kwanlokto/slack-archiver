const $ = (sel) => document.querySelector(sel);

const state = {
  password: localStorage.getItem("admin-password") || "",
};

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (opts.admin) headers["x-admin-password"] = state.password;
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
      box.textContent = `Signed in as @${s.status.user} in ${s.status.team} — but that user is not a workspace owner. Sign in with an owner account.`;
      $("#disconnect").hidden = false;
      break;
    case "credentials_only":
      box.classList.add("warn");
      box.textContent = "App credentials saved. Click 'Sign in with Slack' to finish.";
      break;
    case "error":
      box.classList.add("err");
      box.textContent = `Error: ${s.status.message}`;
      break;
    case "unconfigured":
    default:
      box.classList.add("warn");
      box.textContent = "Not configured yet. Follow the steps below.";
      break;
  }
  $("#redirect-uri-display").textContent = s.redirect_uri;
  const scopeList = $("#scope-list");
  scopeList.innerHTML = "";
  for (const sc of s.required_scopes) {
    const li = document.createElement("li");
    li.innerHTML = `<code>${sc}</code>`;
    scopeList.appendChild(li);
  }
  if (s.has_client_credentials) $("#creds-saved").hidden = false;
}

async function loadStatus() {
  try {
    const s = await api("/api/setup/status");
    renderStatus(s);
  } catch (err) {
    toast(err.message, "err");
  }
}

$("#password-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.password = $("#admin-password").value;
  localStorage.setItem("admin-password", state.password);
  toast("Password stored in browser");
});
$("#admin-password").value = state.password;

$("#creds-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const client_id = $("#client-id").value.trim();
  const client_secret = $("#client-secret").value.trim();
  try {
    await api("/api/setup/credentials", {
      method: "POST",
      body: JSON.stringify({ client_id, client_secret }),
      admin: true,
    });
    toast("Credentials saved");
    $("#client-secret").value = "";
    await loadStatus();
  } catch (err) {
    toast(err.message, "err");
  }
});

$("#disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect from Slack? You'll need to sign in again to resume archiving.")) return;
  try {
    await api("/api/setup/disconnect", { method: "POST", admin: true });
    toast("Disconnected");
    await loadStatus();
  } catch (err) {
    toast(err.message, "err");
  }
});

// Handle OAuth callback flash query params
const params = new URLSearchParams(location.search);
if (params.get("ok") === "1") toast("Signed in successfully");
if (params.get("error")) toast(`OAuth error: ${params.get("error")}`, "err");
if (params.toString()) history.replaceState({}, "", location.pathname);

loadStatus();
