require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const { Server } = require('socket.io');

const APP_NAME = 'Mavryn';
const PORT = Number(process.env.PORT || 10000);
const MAX_ACCOUNTS = 10;
const MAX_USERS = 9;
const ADMIN_NAME = 'A';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pass-10101010.';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is required and must be at least 32 characters.');
  process.exit(1);
}
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'mavryn';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is required.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 3 * 1024 * 1024,
  transports: ['websocket', 'polling'],
  cors: { origin: true, credentials: true }
});

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10, minPoolSize: 1, serverSelectionTimeoutMS: 10000 });
let db;
let bucket;
const onlineSockets = new Map(); // userId => Set(socketId)

const qid = (v) => v && ObjectId.isValid(v) ? new ObjectId(v) : null;
const now = () => new Date();
const safeUser = (u) => u ? ({
  id: u._id.toString(),
  name: u.name,
  displayName: u.profile?.displayName || u.name,
  bio: u.profile?.bio || '',
  avatarUrl: u.profile?.avatarFileId ? `/media/${u.profile.avatarFileId}` : '',
  theme: u.settings?.theme || 'dark',
  statusText: u.settings?.statusText || '',
  role: u.role || 'user',
  online: !!u.online,
  lastSeen: u.lastSeen || null,
  createdAt: u.createdAt
}) : null;

function parseCookieHeader(header = '') {
  const out = {};
  header.split(';').map(s => s.trim()).filter(Boolean).forEach(item => {
    const i = item.indexOf('=');
    if (i > 0) out[item.slice(0, i)] = decodeURIComponent(item.slice(i + 1));
  });
  return out;
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: '14d' });
  res.cookie('mavryn_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 14 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSession(res) {
  res.clearCookie('mavryn_session', { path: '/' });
}

async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.mavryn_session;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.collection('users').findOne({ _id: qid(payload.sub), deletedAt: null });
    if (!user || user.status === 'suspended') return res.status(401).json({ error: 'Account unavailable.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

async function isMember(userId, conversationId) {
  return !!await db.collection('conversations').findOne({ _id: conversationId, participants: userId });
}

function conversationView(c, lastMessage) {
  return {
    id: c._id.toString(),
    type: c.type,
    name: c.name || '',
    avatarUrl: c.avatarFileId ? `/media/${c.avatarFileId}` : '',
    participants: (c.participants || []).map(String),
    admins: (c.admins || []).map(String),
    createdBy: c.createdBy?.toString?.() || null,
    updatedAt: c.updatedAt || c.createdAt,
    lastMessage: lastMessage ? {
      id: lastMessage._id.toString(),
      text: lastMessage.deletedAt ? 'Message deleted' : (lastMessage.text || ''),
      type: lastMessage.type,
      senderId: lastMessage.senderId.toString(),
      createdAt: lastMessage.createdAt
    } : null
  };
}

async function getConversationSummary(userId) {
  const convos = await db.collection('conversations').find({ participants: userId }).sort({ updatedAt: -1 }).limit(100).toArray();
  const out = [];
  for (const c of convos) {
    const last = await db.collection('messages').findOne({ conversationId: c._id }, { sort: { createdAt: -1 } });
    const unreadCount = await db.collection('messages').countDocuments({ conversationId: c._id, senderId: { $ne: userId }, deletedAt: null, seenBy: { $ne: userId } });
    out.push({ ...conversationView(c, last), unreadCount });
  }
  return out;
}

async function broadcastPresence(userId) {
  const u = await db.collection('users').findOne({ _id: userId });
  if (u) io.emit('presence:update', safeUser(u));
}

async function markOnline(userId, socketId) {
  const key = userId.toString();
  let set = onlineSockets.get(key);
  if (!set) { set = new Set(); onlineSockets.set(key, set); }
  set.add(socketId);
  if (set.size === 1) {
    await db.collection('users').updateOne({ _id: userId }, { $set: { online: true } });
    await broadcastPresence(userId);
  }
}

async function markOffline(userId, socketId) {
  const key = userId.toString();
  const set = onlineSockets.get(key);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    onlineSockets.delete(key);
    const lastSeen = now();
    await db.collection('users').updateOne({ _id: userId }, { $set: { online: false, lastSeen } });
    await broadcastPresence(userId);
  }
}

async function seedAdmin() {
  const users = db.collection('users');
  const existing = await users.findOne({ nameKey: ADMIN_NAME.toLowerCase() });
  if (!existing) {
    const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);
    await users.insertOne({
      name: ADMIN_NAME,
      nameKey: ADMIN_NAME.toLowerCase(),
      passwordHash,
      recoveryQuestion: 'What is your favorite color?',
      recoveryAnswerHash: await bcrypt.hash('blue', 12),
      role: 'admin', status: 'active', online: false,
      profile: { displayName: 'A', bio: 'System administrator', avatarFileId: null },
      settings: { theme: 'dark', statusText: 'Administrator' },
      createdAt: now(), updatedAt: now(), lastSeen: null, deletedAt: null
    });
  } else if (existing.role !== 'admin' || existing.deletedAt) {
    await users.updateOne({ _id: existing._id }, { $set: { role: 'admin', deletedAt: null, status: 'active' } });
  }
}

async function ensureAccountCounter() {
  const count = await db.collection('users').countDocuments({ deletedAt: null });
  await db.collection('system').updateOne({ _id: 'accounts' }, { $set: { count, updatedAt: now() } }, { upsert: true });
}

async function ensureIndexes() {
  const users = db.collection('users');
  await users.createIndex({ nameKey: 1 }, { unique: true });
  await users.createIndex({ deletedAt: 1, status: 1 });
  await db.collection('conversations').createIndex({ participants: 1 });
  await db.collection('messages').createIndex({ conversationId: 1, createdAt: -1 });
  await db.collection('stories').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('reports').createIndex({ createdAt: -1 });
  await db.collection('calls').createIndex({ callId: 1 }, { unique: true });
  await db.collection('calls').createIndex({ participants: 1, startedAt: -1 });
  await db.collection('blocks').createIndex({ blockerId: 1, blockedId: 1 }, { unique: true });
}

// Health endpoint for UptimeRobot. It performs a cheap DB ping to keep the application+DB path exercised.
app.get('/api/health', async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: 'ok', app: APP_NAME, time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', error: 'database_unavailable' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    const question = String(req.body.question || '').trim();
    const answer = String(req.body.answer || '').trim();
    if (!/^[\p{L}\p{N} ._'@-]{2,30}$/u.test(name)) return res.status(400).json({ error: 'Choose a valid name (2–30 characters).' });
    if (name.toLowerCase() === ADMIN_NAME.toLowerCase()) return res.status(409).json({ error: 'That name is reserved.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!question || answer.length < 2) return res.status(400).json({ error: 'Recovery question and answer are required.' });
    const reservation = await db.collection('system').findOneAndUpdate({ _id: 'accounts', count: { $lt: MAX_ACCOUNTS } }, { $inc: { count: 1 }, $set: { updatedAt: now() } }, { returnDocument: 'after' });
    if (!reservation) return res.status(409).json({ error: `This private space is full. Maximum ${MAX_ACCOUNTS} accounts.` });
    const nameKey = name.toLowerCase();
    const exists = await db.collection('users').findOne({ nameKey });
    if (exists && !exists.deletedAt) { await db.collection('system').updateOne({ _id: 'accounts' }, { $inc: { count: -1 } }); return res.status(409).json({ error: 'That name is already in use.' }); }
    const createdAt = now();
    const doc = {
      name, nameKey,
      passwordHash: await bcrypt.hash(password, 12),
      recoveryQuestion: question,
      recoveryAnswerHash: await bcrypt.hash(answer.toLowerCase(), 12),
      role: 'user', status: 'active', online: false,
      profile: { displayName: name, bio: '', avatarFileId: null },
      settings: { theme: 'dark', statusText: '' },
      createdAt, updatedAt: createdAt, lastSeen: null, deletedAt: null
    };
    try {
      const result = await db.collection('users').insertOne(doc);
      doc._id = result.insertedId;
      issueSession(res, doc);
      res.json({ user: safeUser(doc), accountsUsed: reservation.count, accountLimit: MAX_ACCOUNTS });
    } catch (insertErr) {
      await db.collection('system').updateOne({ _id: 'accounts' }, { $inc: { count: -1 }, $set: { updatedAt: now() } });
      throw insertErr;
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    const user = await db.collection('users').findOne({ nameKey: name.toLowerCase(), deletedAt: null });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Name or password is incorrect.' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'This account is suspended.' });
    issueSession(res, user);
    await db.collection('users').updateOne({ _id: user._id }, { $set: { lastSeen: now(), updatedAt: now() } });
    res.json({ user: safeUser(user), accountsUsed: await db.collection('users').countDocuments({ deletedAt: null }), accountLimit: MAX_ACCOUNTS });
  } catch (e) { res.status(500).json({ error: 'Login failed.' }); }
});

app.post('/api/auth/logout', async (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get('/api/auth/recovery-question', authLimiter, async (req, res) => {
  const name = String(req.query.name || '').trim();
  const u = await db.collection('users').findOne({ nameKey: name.toLowerCase(), deletedAt: null }, { projection: { recoveryQuestion: 1 } });
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  res.json({ question: u.recoveryQuestion });
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const answer = String(req.body.answer || '').trim().toLowerCase();
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const u = await db.collection('users').findOne({ nameKey: name.toLowerCase(), deletedAt: null });
    if (!u || !(await bcrypt.compare(answer, u.recoveryAnswerHash))) return res.status(401).json({ error: 'Recovery answer is incorrect.' });
    await db.collection('users').updateOne({ _id: u._id }, { $set: { passwordHash: await bcrypt.hash(newPassword, 12), updatedAt: now() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not reset password.' }); }
});

app.get('/api/me', authenticate, async (req, res) => {
  res.json({ user: safeUser(req.user), accountsUsed: await db.collection('users').countDocuments({ deletedAt: null }), accountLimit: MAX_ACCOUNTS });
});

app.get('/api/users', authenticate, async (req, res) => {
  const users = await db.collection('users').find({ deletedAt: null, status: { $ne: 'suspended' } }).project({ passwordHash: 0, recoveryAnswerHash: 0 }).sort({ nameKey: 1 }).toArray();
  res.json({ users: users.map(safeUser) });
});

app.put('/api/me/profile', authenticate, async (req, res) => {
  const displayName = String(req.body.displayName ?? req.user.name).trim().slice(0, 40);
  const bio = String(req.body.bio ?? '').trim().slice(0, 180);
  const statusText = String(req.body.statusText ?? '').trim().slice(0, 80);
  const theme = ['dark','light','system'].includes(req.body.theme) ? req.body.theme : (req.user.settings?.theme || 'dark');
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: {
    'profile.displayName': displayName || req.user.name,
    'profile.bio': bio,
    'settings.statusText': statusText,
    'settings.theme': theme,
    updatedAt: now()
  }});
  const updated = await db.collection('users').findOne({ _id: req.user._id });
  io.emit('profile:update', safeUser(updated));
  res.json({ user: safeUser(updated) });
});

app.put('/api/me/password', authenticate, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const ok = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: { passwordHash: await bcrypt.hash(newPassword, 12), updatedAt: now() } });
  res.json({ ok: true });
});

app.put('/api/me/recovery', authenticate, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const question = String(req.body.question || '').trim();
  const answer = String(req.body.answer || '').trim().toLowerCase();
  if (!question || answer.length < 2) return res.status(400).json({ error: 'Question and answer are required.' });
  if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) return res.status(401).json({ error: 'Current password is incorrect.' });
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: { recoveryQuestion: question, recoveryAnswerHash: await bcrypt.hash(answer, 12), updatedAt: now() } });
  res.json({ ok: true });
});

app.delete('/api/me', authenticate, async (req, res) => {
  if (req.user.role === 'admin') return res.status(400).json({ error: 'The administrator account cannot delete itself.' });
  const tombstone = `deleted_${req.user._id.toString()}`;
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: { deletedAt: now(), status: 'deleted', nameKey: tombstone, name: tombstone, 'profile.displayName': 'Deleted account', online: false } });
  await db.collection('conversations').updateMany({ participants: req.user._id }, { $pull: { participants: req.user._id, admins: req.user._id } });
  await db.collection('system').updateOne({ _id: 'accounts', count: { $gt: 0 } }, { $inc: { count: -1 }, $set: { updatedAt: now() } });
  clearSession(res);
  io.emit('user:deleted', { id: req.user._id.toString() });
  res.json({ ok: true });
});

async function storeFile(buffer, filename, contentType, ownerId, kind) {
  const ext = path.extname(filename).slice(0, 10).replace(/[^a-z0-9.]/gi, '');
  const finalName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext || ''}`;
  return await new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(finalName, { metadata: { ownerId: ownerId.toString(), contentType, kind } });
    upload.on('error', reject);
    upload.on('finish', () => resolve(upload.id));
    upload.end(buffer);
  });
}

function decodeDataUrl(value) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(value || ''));
  if (!match) return null;
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

app.post('/api/me/avatar', authenticate, async (req, res) => {
  const parsed = decodeDataUrl(req.body.dataUrl);
  if (!parsed || !/^image\/(png|jpe?g|webp|gif)$/.test(parsed.contentType) || parsed.buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Avatar must be a PNG, JPG, WEBP or GIF under 2 MB.' });
  const fileId = await storeFile(parsed.buffer, `avatar.${parsed.contentType.split('/')[1]}`, parsed.contentType, req.user._id, 'avatar');
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: { 'profile.avatarFileId': fileId, updatedAt: now() } });
  const updated = await db.collection('users').findOne({ _id: req.user._id });
  io.emit('profile:update', safeUser(updated));
  res.json({ user: safeUser(updated) });
});

app.get('/media/:id', authenticate, async (req, res) => {
  const id = qid(req.params.id);
  if (!id) return res.status(404).end();
  const file = await db.collection('fs.files').findOne({ _id: id });
  if (!file) return res.status(404).end();
  const meta = file.metadata || {};
  const uid = req.user._id.toString();
  let allowed = meta.ownerId === uid || meta.kind === 'avatar' || meta.kind === 'story' || meta.kind === 'group-avatar';
  if (!allowed && meta.kind === 'attachment') {
    const attached = await db.collection('messages').findOne({ 'attachment.fileId': id.toString() });
    if (attached) allowed = await isMember(req.user._id, attached.conversationId);
  }
  if (!allowed) return res.status(403).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Type', file.metadata?.contentType || 'application/octet-stream');
  bucket.openDownloadStream(id).pipe(res);
});

app.post('/api/uploads', authenticate, async (req, res) => {
  const parsed = decodeDataUrl(req.body.dataUrl);
  const filename = String(req.body.filename || 'file').slice(0, 100);
  const kind = String(req.body.kind || 'attachment');
  if (!parsed || parsed.buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Attachment must be under 8 MB.' });
  const allowed = /^(image|video|audio|application|text)\//.test(parsed.contentType);
  if (!allowed) return res.status(400).json({ error: 'Unsupported file type.' });
  const fileId = await storeFile(parsed.buffer, filename, parsed.contentType, req.user._id, kind);
  res.json({ fileId: fileId.toString(), url: `/media/${fileId}`, filename, contentType: parsed.contentType, size: parsed.buffer.length });
});

app.post('/api/conversations/direct', authenticate, async (req, res) => {
  const otherId = qid(req.body.userId);
  if (!otherId || otherId.equals(req.user._id)) return res.status(400).json({ error: 'Invalid user.' });
  const other = await db.collection('users').findOne({ _id: otherId, deletedAt: null, status: 'active' });
  if (!other) return res.status(404).json({ error: 'User not found.' });
  const blocked = await db.collection('blocks').findOne({ $or: [{ blockerId: req.user._id, blockedId: otherId }, { blockerId: otherId, blockedId: req.user._id }] });
  if (blocked) return res.status(403).json({ error: 'Messaging is unavailable because one account has blocked the other.' });
  let c = await db.collection('conversations').findOne({ type: 'direct', participants: { $all: [req.user._id, otherId] }, $expr: { $eq: [{ $size: '$participants' }, 2] } });
  if (!c) {
    const createdAt = now();
    const r = await db.collection('conversations').insertOne({ type: 'direct', participants: [req.user._id, otherId], createdBy: req.user._id, admins: [], createdAt, updatedAt: createdAt });
    c = await db.collection('conversations').findOne({ _id: r.insertedId });
  }
  res.json({ conversation: conversationView(c) });
});

app.get('/api/conversations', authenticate, async (req, res) => {
  res.json({ conversations: await getConversationSummary(req.user._id) });
});

app.get('/api/conversations/:id/messages', authenticate, async (req, res) => {
  const cid = qid(req.params.id);
  if (!cid || !(await isMember(req.user._id, cid))) return res.status(404).json({ error: 'Conversation not found.' });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 100)));
  const docs = await db.collection('messages').find({ conversationId: cid }).sort({ createdAt: -1 }).limit(limit).toArray();
  docs.reverse();
  res.json({ messages: docs.map(m => ({
    id: m._id.toString(), conversationId: cid.toString(), senderId: m.senderId.toString(),
    type: m.type || 'text', text: m.deletedAt ? '' : (m.text || ''),
    attachment: m.attachment || null,
    replyTo: m.replyTo ? m.replyTo.toString() : null,
    reactions: m.reactions || {}, pinned: !!m.pinned, savedBy: (m.savedBy || []).map(String), deliveredBy: (m.deliveredBy || []).map(String),
    seenBy: (m.seenBy || []).map(String), editedAt: m.editedAt || null, deletedAt: m.deletedAt || null, createdAt: m.createdAt
  })) });
});

app.post('/api/conversations/:id/messages', authenticate, async (req, res) => {
  const cid = qid(req.params.id);
  if (!cid || !(await isMember(req.user._id, cid))) return res.status(404).json({ error: 'Conversation not found.' });
  const convoForBlock = await db.collection('conversations').findOne({ _id: cid });
  if (convoForBlock?.type === 'direct') { const otherId = (convoForBlock.participants || []).find(x => !x.equals(req.user._id)); const blocked = otherId && await db.collection('blocks').findOne({ $or: [{ blockerId: req.user._id, blockedId: otherId }, { blockerId: otherId, blockedId: req.user._id }] }); if (blocked) return res.status(403).json({ error: 'Messaging is unavailable because one account has blocked the other.' }); }
  const type = String(req.body.type || 'text');
  const text = String(req.body.text || '').slice(0, 8000);
  const attachment = req.body.attachment && typeof req.body.attachment === 'object' ? req.body.attachment : null;
  if (!text && !attachment && !['sticker','gif'].includes(type)) return res.status(400).json({ error: 'Message is empty.' });
  const msg = { conversationId: cid, senderId: req.user._id, type, text, attachment, replyTo: qid(req.body.replyTo), reactions: {}, pinned: false, savedBy: [], deliveredBy: [], seenBy: [req.user._id], createdAt: now(), updatedAt: now(), deletedAt: null };
  const r = await db.collection('messages').insertOne(msg); msg._id = r.insertedId;
  await db.collection('conversations').updateOne({ _id: cid }, { $set: { updatedAt: msg.createdAt } });
  const payload = { id: msg._id.toString(), conversationId: cid.toString(), senderId: msg.senderId.toString(), type, text, attachment, replyTo: msg.replyTo?.toString() || null, reactions: {}, pinned: false, savedBy: [], deliveredBy: [], seenBy: [req.user._id.toString()], createdAt: msg.createdAt };
  io.to(`conversation:${cid}`).emit('message:new', payload);
  // Notify each other participant via their personal socket room.
  const c = await db.collection('conversations').findOne({ _id: cid });
  for (const pid of c.participants || []) if (!pid.equals(req.user._id)) io.to(`user:${pid}`).emit('notification:new', { type: 'message', conversationId: cid.toString(), message: payload });
  res.json({ message: payload });
});

app.post('/api/conversations/:id/read', authenticate, async (req, res) => {
  const cid = qid(req.params.id), mid = qid(req.body.messageId);
  if (!cid || !mid || !(await isMember(req.user._id, cid))) return res.status(404).json({ error: 'Conversation not found.' });
  await db.collection('messages').updateOne({ _id: mid, conversationId: cid }, { $addToSet: { seenBy: req.user._id } });
  io.to(`conversation:${cid}`).emit('message:seen', { messageId: mid.toString(), userId: req.user._id.toString() });
  res.json({ ok: true });
});


app.post('/api/conversations/:id/delivered', authenticate, async (req, res) => {
  const cid = qid(req.params.id), mid = qid(req.body.messageId);
  if (!cid || !mid || !(await isMember(req.user._id, cid))) return res.status(404).json({ error: 'Conversation not found.' });
  const r = await db.collection('messages').updateOne({ _id: mid, conversationId: cid, senderId: { $ne: req.user._id } }, { $addToSet: { deliveredBy: req.user._id } });
  if (r.matchedCount) io.to(`conversation:${cid}`).emit('message:delivered', { messageId: mid.toString(), userId: req.user._id.toString() });
  res.json({ ok: true });
});

app.post('/api/messages/:id/action', authenticate, async (req, res) => {
  const mid = qid(req.params.id), action = String(req.body.action || '');
  if (!mid) return res.status(400).json({ error: 'Invalid message.' });
  const m = await db.collection('messages').findOne({ _id: mid });
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  if (!(await isMember(req.user._id, m.conversationId))) return res.status(403).json({ error: 'Not a member.' });
  const update = {};
  if (action === 'edit' && m.senderId.equals(req.user._id)) update.$set = { text: String(req.body.text || '').slice(0, 8000), editedAt: now(), updatedAt: now() };
  else if (action === 'delete' && (m.senderId.equals(req.user._id) || req.user.role === 'admin')) update.$set = { deletedAt: now(), text: '', attachment: null, updatedAt: now() };
  else if (action === 'pin') update.$set = { pinned: !m.pinned, updatedAt: now() };
  else if (action === 'save') update.$addToSet = { savedBy: req.user._id };
  else if (action === 'unsave') update.$pull = { savedBy: req.user._id };
  else if (action === 'react') {
    const key = String(req.body.reaction || '');
    if (!['heart','like','laugh','wow','sad','angry'].includes(key)) return res.status(400).json({ error: 'Invalid reaction.' });
    const reactions = { ...(m.reactions || {}) };
    for (const k of Object.keys(reactions)) reactions[k] = (reactions[k] || []).filter(x => String(x) !== req.user._id.toString());
    if (req.body.toggle !== false) reactions[key] = [...(reactions[key] || []), req.user._id.toString()];
    update.$set = { reactions, updatedAt: now() };
  } else return res.status(400).json({ error: 'Unsupported action.' });
  await db.collection('messages').updateOne({ _id: mid }, update);
  const after = await db.collection('messages').findOne({ _id: mid });
  const payload = { id: after._id.toString(), conversationId: after.conversationId.toString(), text: after.deletedAt ? '' : (after.text || ''), reactions: after.reactions || {}, pinned: !!after.pinned, savedBy: (after.savedBy || []).map(String), editedAt: after.editedAt || null, deletedAt: after.deletedAt || null };
  io.to(`conversation:${after.conversationId}`).emit('message:update', payload);
  res.json({ ok: true, message: payload });
});

app.post('/api/groups', authenticate, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  let memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(qid).filter(Boolean) : [];
  memberIds = memberIds.filter(x => x && !x.equals(req.user._id));
  memberIds = [req.user._id, ...memberIds.filter((x, i, arr) => arr.findIndex(y => y.equals(x)) === i)];
  const users = await db.collection('users').countDocuments({ _id: { $in: memberIds }, deletedAt: null });
  if (!name || memberIds.length < 2 || users !== memberIds.length) return res.status(400).json({ error: 'Choose a group name and valid members.' });
  const createdAt = now();
  const r = await db.collection('conversations').insertOne({ type: 'group', name, participants: memberIds, admins: [req.user._id], createdBy: req.user._id, createdAt, updatedAt: createdAt, avatarFileId: null, inviteCode: null });
  const c = await db.collection('conversations').findOne({ _id: r.insertedId });
  for (const pid of memberIds) io.to(`user:${pid}`).emit('conversation:new', conversationView(c));
  res.json({ conversation: conversationView(c) });
});

app.post('/api/groups/:id/members', authenticate, async (req, res) => {
  const cid = qid(req.params.id), uid = qid(req.body.userId);
  const c = cid && await db.collection('conversations').findOne({ _id: cid, type: 'group' });
  if (!c || !uid || !(c.admins || []).some(x => x.equals(req.user._id))) return res.status(403).json({ error: 'Admin access required.' });
  await db.collection('conversations').updateOne({ _id: cid }, { $addToSet: { participants: uid }, $set: { updatedAt: now() } });
  const after = await db.collection('conversations').findOne({ _id: cid });
  io.to(`user:${uid}`).emit('conversation:new', conversationView(after));
  res.json({ conversation: conversationView(after) });
});


app.post('/api/groups/:id/avatar', authenticate, async (req, res) => {
  const cid = qid(req.params.id); const c = cid && await db.collection('conversations').findOne({ _id: cid, type: 'group' });
  if (!c || !(c.admins || []).some(x => x.equals(req.user._id))) return res.status(403).json({ error: 'Group admin access required.' });
  const parsed = decodeDataUrl(req.body.dataUrl);
  if (!parsed || !/^image\/(png|jpe?g|webp|gif)$/.test(parsed.contentType) || parsed.buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Group image must be under 2 MB.' });
  const fileId = await storeFile(parsed.buffer, `group.${parsed.contentType.split('/')[1]}`, parsed.contentType, req.user._id, 'group-avatar');
  await db.collection('conversations').updateOne({ _id: cid }, { $set: { avatarFileId: fileId, updatedAt: now() } });
  const after = await db.collection('conversations').findOne({ _id: cid });
  io.to(`conversation:${cid}`).emit('conversation:update', conversationView(after));
  res.json({ conversation: conversationView(after) });
});

app.get('/api/groups/:id/invite', authenticate, async (req, res) => {
  const cid = qid(req.params.id); const c = cid && await db.collection('conversations').findOne({ _id: cid, type: 'group', participants: req.user._id });
  if (!c) return res.status(404).json({ error: 'Group not found.' });
  const code = c.inviteCode || crypto.randomBytes(10).toString('base64url');
  if (!c.inviteCode) await db.collection('conversations').updateOne({ _id: cid }, { $set: { inviteCode: code } });
  res.json({ inviteCode: code });
});

app.post('/api/groups/join', authenticate, async (req, res) => {
  const code = String(req.body.inviteCode || '').trim();
  const c = await db.collection('conversations').findOne({ type: 'group', inviteCode: code });
  if (!c) return res.status(404).json({ error: 'Invite not found.' });
  await db.collection('conversations').updateOne({ _id: c._id }, { $addToSet: { participants: req.user._id }, $set: { updatedAt: now() } });
  const after = await db.collection('conversations').findOne({ _id: c._id });
  socketEmitConversation(after);
  res.json({ conversation: conversationView(after) });
});

function socketEmitConversation(c) {
  if (!c) return;
  for (const pid of c.participants || []) io.to(`user:${pid}`).emit('conversation:update', conversationView(c));
}

app.delete('/api/groups/:id/members/:uid', authenticate, async (req, res) => {
  const cid = qid(req.params.id), uid = qid(req.params.uid);
  const c = cid && await db.collection('conversations').findOne({ _id: cid, type: 'group' });
  if (!c || !uid || !(c.admins || []).some(x => x.equals(req.user._id))) return res.status(403).json({ error: 'Admin access required.' });
  await db.collection('conversations').updateOne({ _id: cid }, { $pull: { participants: uid, admins: uid }, $set: { updatedAt: now() } });
  io.to(`user:${uid}`).emit('conversation:removed', { conversationId: cid.toString() });
  res.json({ ok: true });
});

app.get('/api/stories', authenticate, async (req, res) => {
  const stories = await db.collection('stories').find({ expiresAt: { $gt: now() } }).sort({ createdAt: -1 }).limit(100).toArray();
  const userIds = [...new Set(stories.map(s => s.userId.toString()))].map(qid);
  const users = await db.collection('users').find({ _id: { $in: userIds }, deletedAt: null }).toArray();
  const map = new Map(users.map(u => [u._id.toString(), safeUser(u)]));
  res.json({ stories: stories.map(s => ({ id: s._id.toString(), user: map.get(s.userId.toString()), text: s.text || '', mediaUrl: s.fileId ? `/media/${s.fileId}` : '', mediaType: s.mediaType || '', createdAt: s.createdAt, expiresAt: s.expiresAt, viewers: (s.viewers || []).map(String) })) });
});

app.post('/api/stories', authenticate, async (req, res) => {
  const text = String(req.body.text || '').slice(0, 500);
  let fileId = null;
  if (req.body.dataUrl) {
    const parsed = decodeDataUrl(req.body.dataUrl);
    if (!parsed || !/^(image\/(png|jpe?g|webp)|video\/(mp4|webm|ogg))$/.test(parsed.contentType) || parsed.buffer.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Story media must be an image or short video under 4 MB.' });
    fileId = await storeFile(parsed.buffer, `story.${parsed.contentType.split('/')[1]}`, parsed.contentType, req.user._id, 'story');
    req.body.mediaType = parsed.contentType;
  }
  if (!text && !fileId) return res.status(400).json({ error: 'Story is empty.' });
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  const r = await db.collection('stories').insertOne({ userId: req.user._id, text, fileId, mediaType: req.body.mediaType || '', createdAt, expiresAt, viewers: [] });
  io.emit('story:new', { id: r.insertedId.toString(), userId: req.user._id.toString() });
  res.json({ ok: true });
});

app.post('/api/stories/:id/view', authenticate, async (req, res) => {
  const sid = qid(req.params.id);
  await db.collection('stories').updateOne({ _id: sid }, { $addToSet: { viewers: req.user._id } });
  res.json({ ok: true });
});



app.get('/api/blocks', authenticate, async (req, res) => {
  const rows = await db.collection('blocks').find({ blockerId: req.user._id }).toArray();
  const ids = rows.map(r => r.blockedId);
  const users = await db.collection('users').find({ _id: { $in: ids }, deletedAt: null }).toArray();
  res.json({ users: users.map(safeUser) });
});

app.post('/api/blocks/:id', authenticate, async (req, res) => {
  const blockedId = qid(req.params.id);
  if (!blockedId || blockedId.equals(req.user._id)) return res.status(400).json({ error: 'Invalid account.' });
  const target = await db.collection('users').findOne({ _id: blockedId, deletedAt: null });
  if (!target || target.role === 'admin') return res.status(400).json({ error: 'This account cannot be blocked.' });
  await db.collection('blocks').updateOne({ blockerId: req.user._id, blockedId }, { $setOnInsert: { blockerId: req.user._id, blockedId, createdAt: now() } }, { upsert: true });
  res.json({ ok: true });
});

app.delete('/api/blocks/:id', authenticate, async (req, res) => {
  const blockedId = qid(req.params.id);
  if (!blockedId) return res.status(400).json({ error: 'Invalid account.' });
  await db.collection('blocks').deleteOne({ blockerId: req.user._id, blockedId });
  res.json({ ok: true });
});

app.get('/api/calls', authenticate, async (req, res) => {
  const docs = await db.collection('calls').find({ participants: req.user._id }).sort({ startedAt: -1 }).limit(50).toArray();
  const otherIds = [...new Set(docs.flatMap(c => (c.participants || []).filter(id => !id.equals(req.user._id)).map(String)))].map(qid);
  const users = await db.collection('users').find({ _id: { $in: otherIds }, deletedAt: null }).toArray();
  const map = new Map(users.map(u => [u._id.toString(), safeUser(u)]));
  res.json({ calls: docs.map(c => ({ id: c._id.toString(), callId: c.callId, userId: (c.participants || []).find(id => !id.equals(req.user._id))?.toString() || null, kind: c.kind, status: c.status, startedAt: c.startedAt, endedAt: c.endedAt })) });
});

app.post('/api/calls', authenticate, async (req, res) => {
  const callId = String(req.body.callId || '').slice(0, 80), other = qid(req.body.userId), kind = req.body.kind === 'video' ? 'video' : 'audio';
  if (!callId || !other) return res.status(400).json({ error: 'Invalid call.' });
  const u = await db.collection('users').findOne({ _id: other, deletedAt: null, status: 'active' });
  if (!u) return res.status(404).json({ error: 'User not found.' });
  await db.collection('calls').updateOne({ callId }, { $setOnInsert: { callId, participants: [req.user._id, other], kind, status: String(req.body.status || 'outgoing'), startedAt: now(), endedAt: null } }, { upsert: true });
  res.json({ ok: true });
});

app.patch('/api/calls/:callId', authenticate, async (req, res) => {
  const callId = String(req.params.callId); const c = await db.collection('calls').findOne({ callId, participants: req.user._id });
  if (!c) return res.status(404).json({ error: 'Call not found.' });
  await db.collection('calls').updateOne({ _id: c._id }, { $set: { status: String(req.body.status || 'ended'), endedAt: now() } });
  res.json({ ok: true });
});

app.get('/api/search', authenticate, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], messages: [] });
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await db.collection('users').find({ deletedAt: null, $or: [{ name: rx }, { 'profile.displayName': rx }, { 'profile.bio': rx }] }).limit(20).toArray();
  const userConvos = await db.collection('conversations').find({ participants: req.user._id }).project({ _id: 1 }).toArray();
  const convoIds = userConvos.map(x => x._id);
  const messages = await db.collection('messages').find({ conversationId: { $in: convoIds }, text: rx, deletedAt: null }).sort({ createdAt: -1 }).limit(30).toArray();
  res.json({ users: users.map(safeUser), messages: messages.map(m => ({ id: m._id.toString(), conversationId: m.conversationId.toString(), senderId: m.senderId.toString(), text: m.text, createdAt: m.createdAt })) });
});


app.post('/api/messages/:id/forward', authenticate, async (req, res) => {
  try {
    const mid = qid(req.params.id), targetId = qid(req.body.conversationId);
    if (!mid || !targetId) return res.status(400).json({ error: 'Invalid message or conversation.' });
    const original = await db.collection('messages').findOne({ _id: mid });
    if (!original) return res.status(404).json({ error: 'Message not found.' });
    const target = await db.collection('conversations').findOne({ _id: targetId, participants: req.user._id });
    const source = await db.collection('conversations').findOne({ _id: original.conversationId, participants: req.user._id });
    if (!target || !source) return res.status(403).json({ error: 'Conversation access denied.' });
    const createdAt = now();
    const message = {
      conversationId: targetId,
      senderId: req.user._id,
      type: original.type,
      text: original.text || '',
      attachmentId: original.attachmentId || null,
      attachmentName: original.attachmentName || null,
      attachmentMime: original.attachmentMime || null,
      replyTo: null,
      forwardedFrom: original.senderId,
      createdAt,
      editedAt: null,
      deletedAt: null,
      pinnedBy: null,
      savedBy: []
    };
    const r = await db.collection('messages').insertOne(message);
    message._id = r.insertedId;
    await db.collection('conversations').updateOne({ _id: targetId }, { $set: { updatedAt: createdAt } });
    const view = messageView(message);
    io.to(`conversation:${targetId}`).emit('message:new', view);
    res.json({ message: view });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not forward message.' });
  }
});

app.post('/api/reports', authenticate, async (req, res) => {
  const targetUserId = qid(req.body.targetUserId);
  const messageId = qid(req.body.messageId);
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'Reason is required.' });
  await db.collection('reports').insertOne({ reporterId: req.user._id, targetUserId, messageId, reason, status: 'open', createdAt: now(), updatedAt: now() });
  if (targetUserId) io.to(`user:${targetUserId}`).emit('notice:report', { reason });
  res.json({ ok: true });
});

// ----- Admin panel API -----
app.get('/api/admin/stats', authenticate, adminOnly, async (_req, res) => {
  const [users, messages, conversations, stories, openReports] = await Promise.all([
    db.collection('users').countDocuments({ deletedAt: null }),
    db.collection('messages').countDocuments({}),
    db.collection('conversations').countDocuments({}),
    db.collection('stories').countDocuments({ expiresAt: { $gt: now() } }),
    db.collection('reports').countDocuments({ status: 'open' })
  ]);
  res.json({ users, capacity: MAX_ACCOUNTS, remaining: MAX_ACCOUNTS - users, messages, conversations, stories, openReports });
});

app.get('/api/admin/users', authenticate, adminOnly, async (_req, res) => {
  const users = await db.collection('users').find({}).sort({ createdAt: 1 }).project({ passwordHash: 0, recoveryAnswerHash: 0 }).toArray();
  res.json({ users: users.map(u => ({ ...safeUser(u), status: u.status, deletedAt: u.deletedAt })) });
});

app.patch('/api/admin/users/:id', authenticate, adminOnly, async (req, res) => {
  const uid = qid(req.params.id);
  const u = uid && await db.collection('users').findOne({ _id: uid, deletedAt: null });
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const action = String(req.body.action || '');
  if (u.role === 'admin' && action === 'suspend') return res.status(400).json({ error: 'The administrator account cannot be suspended.' });
  if (action === 'suspend') await db.collection('users').updateOne({ _id: uid }, { $set: { status: 'suspended', online: false, updatedAt: now() } });
  else if (action === 'unsuspend') await db.collection('users').updateOne({ _id: uid }, { $set: { status: 'active', updatedAt: now() } });
  else if (action === 'delete') {
    if (u.role === 'admin') return res.status(400).json({ error: 'The administrator account cannot be deleted.' });
    const tombstone = `deleted_${u._id.toString()}`;
    await db.collection('users').updateOne({ _id: uid }, { $set: { deletedAt: now(), status: 'deleted', nameKey: tombstone, name: tombstone, 'profile.displayName': 'Deleted account', online: false } });
    await db.collection('conversations').updateMany({ participants: uid }, { $pull: { participants: uid, admins: uid } });
    await db.collection('system').updateOne({ _id: 'accounts', count: { $gt: 0 } }, { $inc: { count: -1 }, $set: { updatedAt: now() } });
    io.emit('user:deleted', { id: uid.toString() });
  } else return res.status(400).json({ error: 'Unsupported action.' });
  const after = await db.collection('users').findOne({ _id: uid });
  io.emit('admin:user:update', { user: after ? safeUser(after) : { id: uid.toString(), deleted: true } });
  res.json({ ok: true });
});

app.get('/api/admin/reports', authenticate, adminOnly, async (_req, res) => {
  const reports = await db.collection('reports').find({}).sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ reports: reports.map(r => ({ id: r._id.toString(), reporterId: r.reporterId.toString(), targetUserId: r.targetUserId?.toString() || null, messageId: r.messageId?.toString() || null, reason: r.reason, status: r.status, createdAt: r.createdAt })) });
});

app.patch('/api/admin/reports/:id', authenticate, adminOnly, async (req, res) => {
  const rid = qid(req.params.id), status = ['open','reviewing','resolved','dismissed'].includes(req.body.status) ? req.body.status : null;
  if (!rid || !status) return res.status(400).json({ error: 'Invalid status.' });
  await db.collection('reports').updateOne({ _id: rid }, { $set: { status, updatedAt: now() } });
  res.json({ ok: true });
});

app.get('/api/admin/announcement', authenticate, adminOnly, async (_req, res) => {
  const s = await db.collection('settings').findOne({ key: 'announcement' });
  res.json({ announcement: s?.value || '' });
});
app.put('/api/admin/announcement', authenticate, adminOnly, async (req, res) => {
  const value = String(req.body.value || '').trim().slice(0, 400);
  await db.collection('settings').updateOne({ key: 'announcement' }, { $set: { key: 'announcement', value, updatedAt: now() } }, { upsert: true });
  io.emit('announcement:update', { value });
  res.json({ ok: true, value });
});


app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large.' });
  res.status(500).json({ error: 'Internal server error.' });
});

// SPA and PWA assets
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir, { extensions: ['html'] }));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(clientDir, 'index.html'));
});

// Socket auth + realtime events
io.use(async (socket, next) => {
  try {
    const cookies = parseCookieHeader(socket.request.headers.cookie || '');
    const token = cookies.mavryn_session;
    if (!token) return next(new Error('unauthorized'));
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.collection('users').findOne({ _id: qid(payload.sub), deletedAt: null, status: 'active' });
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  } catch { next(new Error('unauthorized')); }
});

io.on('connection', async socket => {
  const uid = socket.user._id;
  socket.join(`user:${uid}`);
  await markOnline(uid, socket.id);
  const convos = await db.collection('conversations').find({ participants: uid }).project({ _id: 1 }).toArray();
  for (const c of convos) socket.join(`conversation:${c._id}`);
  const announcement = await db.collection('settings').findOne({ key: 'announcement' });
  if (announcement?.value) socket.emit('announcement:update', { value: announcement.value });

  socket.on('conversation:join', async conversationId => {
    const cid = qid(conversationId);
    if (cid && await isMember(uid, cid)) socket.join(`conversation:${cid}`);
  });
  socket.on('typing:start', conversationId => socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId: uid.toString(), active: true }));
  socket.on('typing:stop', conversationId => socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId: uid.toString(), active: false }));

  // WebRTC signaling, relayed only between authenticated users in this private instance.
  socket.on('call:ring', async ({ to, conversationId, kind, callId }) => { const toId=qid(to), cid=qid(conversationId); if(!toId||!cid||!await isMember(uid,cid)||!await isMember(toId,cid)) return; const blocked=await db.collection('blocks').findOne({$or:[{blockerId:uid,blockedId:toId},{blockerId:toId,blockedId:uid}]}); if(blocked) return; await db.collection('calls').updateOne({callId:String(callId||'')},{ $setOnInsert:{callId:String(callId||''),participants:[uid,toId],kind:kind==='video'?'video':'audio',status:'ringing',startedAt:now(),endedAt:null}},{upsert:true}); io.to(`user:${toId}`).emit('call:ring',{from:uid.toString(),conversationId:cid.toString(),kind:kind==='video'?'video':'audio',callId}); });
  socket.on('call:offer', ({ to, callId, description }) => io.to(`user:${to}`).emit('call:offer', { from: uid.toString(), callId, description }));
  socket.on('call:answer', ({ to, callId, description }) => io.to(`user:${to}`).emit('call:answer', { from: uid.toString(), callId, description }));
  socket.on('call:ice', ({ to, callId, candidate }) => io.to(`user:${to}`).emit('call:ice', { from: uid.toString(), callId, candidate }));
  socket.on('call:end', ({ to, callId }) => io.to(`user:${to}`).emit('call:end', { from: uid.toString(), callId }));
  socket.on('disconnect', () => markOffline(uid, socket.id).catch(console.error));
});

async function start() {
  await client.connect();
  db = client.db(DB_NAME);
  bucket = new GridFSBucket(db, { bucketName: 'mavryn' });
  await ensureIndexes();
  await seedAdmin();
  await ensureAccountCounter();
  server.listen(PORT, () => console.log(`${APP_NAME} listening on port ${PORT}`));
}

start().catch(err => { console.error(err); process.exit(1); });

process.on('SIGTERM', async () => { try { await client.close(); } finally { process.exit(0); } });
process.on('SIGINT', async () => { try { await client.close(); } finally { process.exit(0); } });
