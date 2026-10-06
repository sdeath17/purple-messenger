const $ = id => document.getElementById(id);

let token = localStorage.getItem("purple_token");
let me = null;
let activeUser = null;
let socket = null;
let recentChats = JSON.parse(localStorage.getItem("purple_recent") || "[]");

function api(path, options = {}) {
  options.headers = options.headers || {};
  if (token) options.headers.Authorization = `Bearer ${token}`;
  return fetch(path, options).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Ошибка запроса");
    return data;
  });
}

function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2300);
}

function initials(name) {
  return (name || "?").slice(0, 1).toUpperCase();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function setMode(mode) {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x.dataset.mode === mode));
  $("authSubmit").textContent = mode === "login" ? "Войти" : "Создать аккаунт";
  $("authError").textContent = "";
  $("authPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authForm").dataset.mode = mode;
}
document.querySelectorAll(".tab").forEach(btn => btn.onclick = () => setMode(btn.dataset.mode));

$("authForm").onsubmit = async e => {
  e.preventDefault();
  const mode = e.currentTarget.dataset.mode || "login";
  $("authError").textContent = "";
  try {
    const data = await api(`/api/${mode}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ username:$("authUsername").value, password:$("authPassword").value })
    });
    token = data.token;
    localStorage.setItem("purple_token", token);
    me = data.user;
    enterApp();
  } catch (err) {
    $("authError").textContent = err.message;
  }
};

async function enterApp() {
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("myName").textContent = "@" + me.username;
  $("myAvatar").textContent = initials(me.username);
  connectSocket();
  renderRecent();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on("message", msg => {
    if (activeUser && (msg.fromId === activeUser.id || msg.toId === activeUser.id)) {
      addMessage(msg);
      scrollMessages();
    }
    if (msg.fromId === me.id) rememberChat(msg.toId);
    else rememberChat(msg.fromId);
    renderRecent();
  });
}

async function checkSession() {
  if (!token) return;
  try {
    const data = await api("/api/me");
    me = data.user;
    enterApp();
  } catch {
    localStorage.removeItem("purple_token");
    token = null;
  }
}
checkSession();

$("logoutBtn").onclick = () => {
  localStorage.removeItem("purple_token");
  location.reload();
};

let searchTimer;
$("searchInput").oninput = () => {
  clearTimeout(searchTimer);
  const q = $("searchInput").value.trim();
  if (!q) { $("searchResults").innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    try {
      const users = await api("/api/users?q=" + encodeURIComponent(q));
      $("searchResults").innerHTML = users.length ? users.map(u => `
        <div class="user-result" data-id="${u.id}">
          <div class="avatar">${initials(u.username)}</div><div><b>@${escapeHtml(u.username)}</b></div>
        </div>`).join("") : `<div class="tiny" style="padding:10px">Никого не найдено</div>`;
      document.querySelectorAll(".user-result").forEach(el => el.onclick = () => openChat(el.dataset.id));
    } catch {}
  }, 180);
};

async function openChat(userId) {
  try {
    const data = await api(`/api/messages/${userId}`);
    activeUser = data.user;
    rememberChat(userId);
    $("emptyChat").classList.add("hidden");
    $("chatView").classList.remove("hidden");
    $("chat").classList?.remove("mobile-hidden");
    $("chatName").textContent = "@" + activeUser.username;
    $("chatAvatar").textContent = initials(activeUser.username);
    $("messages").innerHTML = "";
    data.messages.forEach(addMessage);
    scrollMessages();
    if (innerWidth <= 720) $("appView").querySelector(".sidebar").style.display = "none";
  } catch (err) { showToast(err.message); }
}

function addMessage(msg) {
  const el = document.createElement("div");
  const mine = msg.fromId === me.id;
  el.className = "msg" + (mine ? " mine" : "");
  let body = "";
  if (msg.type === "image" && msg.imageUrl) {
    body = `<div class="bubble image-bubble"><a href="${msg.imageUrl}" target="_blank" rel="noopener"><img src="${msg.imageUrl}" alt="Фото"></a></div>`;
  } else {
    body = `<div class="bubble">${escapeHtml(msg.text).replace(/\n/g,"<br>")}</div>`;
  }
  el.innerHTML = `${body}<div class="time">${formatTime(msg.createdAt)}</div>`;
  $("messages").appendChild(el);
}

function scrollMessages() {
  $("messages").scrollTop = $("messages").scrollHeight;
}

async function sendText() {
  if (!activeUser) return;
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await api("/api/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({toId:activeUser.id, text})
    });
  } catch (err) { showToast(err.message); }
}

$("messageForm").onsubmit = e => { e.preventDefault(); sendText(); };
$("messageInput").onkeydown = e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
};

$("imageBtn").onclick = () => $("imageInput").click();
$("imageInput").onchange = async () => {
  if (!activeUser || !$("imageInput").files[0]) return;
  const fd = new FormData();
  fd.append("image", $("imageInput").files[0]);
  fd.append("toId", activeUser.id);
  try {
    await api("/api/upload", { method:"POST", body:fd });
    $("imageInput").value = "";
  } catch (err) { showToast(err.message); }
};

function rememberChat(id) {
  recentChats = [id, ...recentChats.filter(x => x !== id)].slice(0, 15);
  localStorage.setItem("purple_recent", JSON.stringify(recentChats));
}

async function renderRecent() {
  const items = [];
  for (const id of recentChats) {
    try {
      const data = await api(`/api/messages/${id}`);
      items.push(data);
    } catch {}
  }
  $("chatList").innerHTML = items.map(data => {
    const last = data.messages.at(-1);
    const preview = last ? (last.type === "image" ? "📷 Фото" : last.text) : "Начать чат";
    return `<div class="chat-item" data-id="${data.user.id}">
      <div class="avatar">${initials(data.user.username)}</div>
      <div><b>@${escapeHtml(data.user.username)}</b><small>${escapeHtml(preview)}</small></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".chat-item").forEach(el => el.onclick = () => openChat(el.dataset.id));
}

$("backBtn").onclick = () => {
  $("appView").querySelector(".sidebar").style.display = "";
  $("chatView").classList.add("hidden");
  $("emptyChat").classList.remove("hidden");
  activeUser = null;
};
