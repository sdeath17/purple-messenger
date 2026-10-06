import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!JWT_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing JWT_SECRET, SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, /^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype))
});

const cleanUser = u => ({ id: u.id, username: u.username, createdAt: u.created_at });

async function getUserById(id) {
  const { data, error } = await supabase.from("users").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getUserByName(username) {
  const { data, error } = await supabase
    .from("users").select("*").ilike("username", username).maybeSingle();
  if (error) throw error;
  return data;
}

function tokenFor(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
}

async function auth(req, res, next) {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const payload = jwt.verify(raw, JWT_SECRET);
    const user = await getUserById(payload.id);
    if (!user) return res.status(401).json({ error: "Пользователь не найден." });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Сессия истекла. Войдите снова." });
  }
}

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: "Ник: 3–20 символов, латиница, цифры и _." });
    if (password.length < 6 || password.length > 100)
      return res.status(400).json({ error: "Пароль должен быть от 6 символов." });

    const exists = await getUserByName(username);
    if (exists) return res.status(409).json({ error: "Такой ник уже занят." });

    const user = {
      id: crypto.randomUUID(),
      username,
      password_hash: await bcrypt.hash(password, 12)
    };
    const { data, error } = await supabase.from("users").insert(user).select().single();
    if (error) throw error;
    res.json({ token: tokenFor(data), user: cleanUser(data) });
  } catch (e) {
    res.status(500).json({ error: "Не удалось создать аккаунт." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = await getUserByName(username);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Неверный ник или пароль." });
    res.json({ token: tokenFor(user), user: cleanUser(user) });
  } catch {
    res.status(500).json({ error: "Ошибка сервера." });
  }
});

app.get("/api/me", auth, (req, res) => res.json({ user: cleanUser(req.user) }));

app.get("/api/users", auth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  const { data, error } = await supabase
    .from("users").select("id,username,created_at")
    .ilike("username", `%${q}%`).neq("id", req.user.id).limit(20);
  if (error) return res.status(500).json({ error: "Ошибка поиска." });
  res.json((data || []).map(cleanUser));
});

function chatPair(a,b) {
  return [a,b].sort().join(":");
}

app.get("/api/messages/:userId", auth, async (req,res) => {
  const other = await getUserById(req.params.userId);
  if (!other) return res.status(404).json({error:"Пользователь не найден."});
  const key = chatPair(req.user.id, other.id);
  const { data, error } = await supabase.from("messages")
    .select("*").eq("chat_key",key).order("created_at",{ascending:true}).limit(300);
  if (error) return res.status(500).json({error:"Не удалось загрузить чат."});
  res.json({user:cleanUser(other),messages:data || []});
});

async function saveMessage(from,to,type,text="",imageUrl=null) {
  const row = {
    id: crypto.randomUUID(),
    chat_key: chatPair(from.id,to.id),
    from_id: from.id,
    to_id: to.id,
    type,
    text,
    image_url: imageUrl
  };
  const {data,error}=await supabase.from("messages").insert(row).select().single();
  if(error) throw error;
  return {
    id:data.id, chatKey:data.chat_key, fromId:data.from_id, toId:data.to_id,
    type:data.type, text:data.text, imageUrl:data.image_url, createdAt:data.created_at
  };
}

app.post("/api/messages", auth, async (req,res) => {
  try {
    const to=await getUserById(String(req.body.toId||""));
    const text=String(req.body.text||"").trim();
    if(!to || to.id===req.user.id) return res.status(400).json({error:"Некорректный получатель."});
    if(!text || text.length>4000) return res.status(400).json({error:"Сообщение пустое или слишком длинное."});
    const msg=await saveMessage(req.user,to,"text",text);
    io.to(to.id).emit("message",msg); io.to(req.user.id).emit("message",msg);
    res.json({message:msg});
  } catch { res.status(500).json({error:"Не удалось отправить сообщение."}); }
});

app.post("/api/upload", auth, upload.single("image"), async (req,res) => {
  try {
    const to=await getUserById(String(req.body.toId||""));
    if(!req.file) return res.status(400).json({error:"Выберите JPG, PNG, GIF или WebP до 8 МБ."});
    if(!to || to.id===req.user.id) return res.status(400).json({error:"Некорректный получатель."});

    const ext = req.file.mimetype.split("/")[1].replace("jpeg","jpg");
    const filename=`${crypto.randomUUID()}.${ext}`;
    const pathName=`chat/${filename}`;
    const {error:uploadError}=await supabase.storage.from("chat-images")
      .upload(pathName,req.file.buffer,{contentType:req.file.mimetype,upsert:false});
    if(uploadError) throw uploadError;

    const {data:urlData}=supabase.storage.from("chat-images").getPublicUrl(pathName);
    const msg=await saveMessage(req.user,to,"image","",urlData.publicUrl);
    io.to(to.id).emit("message",msg); io.to(req.user.id).emit("message",msg);
    res.json({message:msg});
  } catch { res.status(500).json({error:"Не удалось загрузить фото."}); }
});

io.use(async(socket,next)=>{
  try {
    const payload=jwt.verify(socket.handshake.auth?.token||"",JWT_SECRET);
    const user=await getUserById(payload.id);
    if(!user) return next(new Error("Unauthorized"));
    socket.user=user; next();
  } catch { next(new Error("Unauthorized")); }
});
io.on("connection",socket=>socket.join(socket.user.id));

app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
server.listen(PORT,()=>console.log(`Purple Messenger listening on ${PORT}`));
