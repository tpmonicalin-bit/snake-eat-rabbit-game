// ===== 常量 =====
// CANVAS_W/H 会在进入对局时按屏幕实际可用空间重新计算，这里只是初始默认值
let CANVAS_W = 800;
let CANVAS_H = 600;
const ENTITY_RADIUS = 30;
const CATCH_RADIUS = 34;
const SNAKE_SPEED = 210; // px/s
const RABBIT_SPEED = 235; // px/s，兔子稍快一点，逃跑才有意思
const ROUND_DURATION_MS = 75000;
const BROADCAST_MS = 66; // ~15 次/秒
const TRAIL_SEGMENT_COUNT = 14;
const TRAIL_SEGMENT_SPACING = 14;
const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉容易看混的 0/O/1/I

const KEY_MAP = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
  W: "up", S: "down", A: "left", D: "right",
};

// ===== DOM =====
const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game"),
  end: document.getElementById("screen-end"),
};
const homeErrorEl = document.getElementById("home-error");
const joinCodeInput = document.getElementById("input-join-code");
const lobbyCodeEl = document.getElementById("lobby-code");
const lobbyRoleEl = document.getElementById("lobby-role");
const hudRoleEl = document.getElementById("hud-role");
const hudTimerEl = document.getElementById("hud-timer");
const endResultEl = document.getElementById("end-result");
const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const gardenBg = buildGardenBackground();
const joystickBase = document.getElementById("joystick-base");
const joystickKnob = document.getElementById("joystick-knob");
const controlHintEl = document.getElementById("control-hint");
const hudEl = document.querySelector("#screen-game .hud");
const appShellEl = document.getElementById("app-shell");
const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;

// 手机 Safari 的悬浮地址栏/标签栏有时会浮在页面内容上方而不是把内容往下推，
// 导致画面顶部（HUD、标题）被挡住。用 visualViewport 量出被挡住的高度，把内容整体平移下去。
function adjustForBrowserChrome() {
  if (!window.visualViewport || !appShellEl) return;
  const offset = window.visualViewport.offsetTop || 0;
  appShellEl.style.transform = offset > 0.5 ? `translateY(${offset}px)` : "";
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", adjustForBrowserChrome);
  window.visualViewport.addEventListener("scroll", adjustForBrowserChrome);
}
window.addEventListener("load", adjustForBrowserChrome);
window.addEventListener("orientationchange", () => setTimeout(adjustForBrowserChrome, 300));

// 让画布随屏幕可用空间自适应，避免在窄/矮的手机屏幕上出现两侧黑边或超出屏幕
function resizeCanvas() {
  const cs = getComputedStyle(screens.game);
  const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

  const availW = Math.min(800, screens.game.clientWidth - padH);
  const reservedH = (hudEl ? hudEl.offsetHeight : 40) + (controlHintEl ? controlHintEl.offsetHeight : 24) + padV + 24;
  const availH = Math.min(600, window.innerHeight - reservedH);

  CANVAS_W = Math.max(320, Math.round(availW));
  CANVAS_H = Math.max(220, Math.round(availH));

  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
}

window.addEventListener("resize", () => {
  adjustForBrowserChrome();
  if (state.loopRunning) resizeCanvas();
});

// ===== 状态 =====
const state = {
  roomId: null,
  myRole: null,
  otherRole: null,
  roomRef: null,
  stateListener: null,
  remoteListener: null,
  local: { x: 100, y: 100, angle: 0 },
  remote: { x: 700, y: 100, angle: Math.PI },
  remoteRender: { x: 700, y: 100, angle: Math.PI },
  keys: {},
  joystick: { active: false, dx: 0, dy: 0, pointerId: null },
  trail: [],
  roundEnded: false,
  loopRunning: false,
  lastFrameTime: 0,
  lastBroadcast: 0,
  startTime: null,
  roundDuration: ROUND_DURATION_MS,
};

// ===== 工具函数 =====
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

function showError(msg) {
  homeErrorEl.textContent = msg;
  homeErrorEl.classList.remove("hidden");
}

function clearError() {
  homeErrorEl.classList.add("hidden");
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function roleLabel(role) {
  return role === "snake" ? "🐍 蛇" : "🐰 兔子";
}

// 出生点用画布尺寸的百分比算，这样不同屏幕尺寸下画布大小变了也不会跑出边界
function spawnFor(role) {
  return role === "snake"
    ? { x: CANVAS_W * 0.14, y: CANVAS_H * 0.22, angle: 0 }
    : { x: CANVAS_W * 0.86, y: CANVAS_H * 0.22, angle: Math.PI };
}

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

// ===== 创建 / 加入房间 =====
async function createRoom(role) {
  clearError();
  for (let attempt = 0; attempt < 5; attempt++) {
    const roomId = generateRoomCode();
    const roomRef = db.ref(`rooms/${roomId}`);
    const snap = await roomRef.once("value");
    if (snap.exists()) continue; // 撞码了，重试

    await roomRef.set({
      players: { [role]: true },
      state: { status: "waiting", startTime: null, duration: ROUND_DURATION_MS, winner: null },
      positions: { [role]: { ...spawnFor(role), t: Date.now() } },
    });

    enterRoom(roomId, role);
    return;
  }
  showError("创建房间失败，请重试");
}

async function joinRoom(roomId, code) {
  clearError();
  const roomRef = db.ref(`rooms/${roomId}`);
  const snap = await roomRef.once("value");
  if (!snap.exists()) {
    showError("房间不存在，检查一下房间码");
    return;
  }
  const data = snap.val();
  const players = data.players || {};
  const openRole = !players.snake ? "snake" : !players.rabbit ? "rabbit" : null;
  if (!openRole) {
    showError("房间已满了");
    return;
  }

  await roomRef.update({
    [`players/${openRole}`]: true,
    [`positions/${openRole}`]: { ...spawnFor(openRole), t: Date.now() },
    "state/status": "playing",
    "state/startTime": firebase.database.ServerValue.TIMESTAMP,
    "state/winner": null,
  });

  enterRoom(roomId, openRole);
}

function enterRoom(roomId, myRole) {
  state.roomId = roomId;
  state.myRole = myRole;
  state.otherRole = myRole === "snake" ? "rabbit" : "snake";
  state.local = spawnFor(myRole);
  state.remote = spawnFor(state.otherRole);
  state.remoteRender = { ...state.remote };
  state.roundEnded = false;

  lobbyCodeEl.textContent = roomId;
  lobbyRoleEl.textContent = `你是 ${roleLabel(myRole)}`;
  showScreen("lobby");

  const roomRef = db.ref(`rooms/${roomId}`);
  state.roomRef = roomRef;

  state.stateListener = roomRef.child("state").on("value", (snap) => {
    const s = snap.val();
    if (s) handleStateChange(s);
  });

  state.remoteListener = roomRef.child(`positions/${state.otherRole}`).on("value", (snap) => {
    const p = snap.val();
    if (p) state.remote = p;
  });
}

function leaveRoom() {
  if (state.roomRef) {
    if (state.stateListener) state.roomRef.child("state").off("value", state.stateListener);
    if (state.remoteListener) state.roomRef.child(`positions/${state.otherRole}`).off("value", state.remoteListener);
  }
  stopGameLoop();
  state.roomId = null;
  state.myRole = null;
  state.otherRole = null;
  state.roomRef = null;
  state.stateListener = null;
  state.remoteListener = null;
  state.keys = {};
  resetJoystick();
  showScreen("home");
}

// ===== 状态机 =====
function handleStateChange(s) {
  state.roundDuration = s.duration || ROUND_DURATION_MS;
  state.startTime = s.startTime || null;

  if (s.status === "playing") {
    state.roundEnded = false;
    hudRoleEl.textContent = `你是 ${roleLabel(state.myRole)}`;
    showScreen("game");
    joystickBase.classList.toggle("hidden", !isTouchDevice);
    controlHintEl.textContent = isTouchDevice ? "拖动右下角摇杆移动" : "方向键 / WASD 移动";
    resizeCanvas(); // 屏幕现在可见了，按实际可用空间算画布大小
    adjustForBrowserChrome();
    state.local = spawnFor(state.myRole);
    state.remote = spawnFor(state.otherRole);
    state.remoteRender = { ...state.remote };
    state.trail = [];
    if (!state.loopRunning) startGameLoop();
  } else if (s.status === "ended") {
    state.roundEnded = true;
    stopGameLoop();
    showEndScreen(s.winner);
  } else if (s.status === "waiting") {
    showScreen("lobby");
  }
}

function showEndScreen(winner) {
  endResultEl.textContent = winner === "snake" ? "🐍 蛇赢了！兔子被抓到了" : "🐰 兔子赢了！撑到了最后";
  showScreen("end");
}

// ===== 输入 =====
function isTypingTarget(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

window.addEventListener("keydown", (e) => {
  if (isTypingTarget(document.activeElement)) return;
  const dir = KEY_MAP[e.key];
  if (dir) {
    state.keys[dir] = true;
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => {
  if (isTypingTarget(document.activeElement)) return;
  const dir = KEY_MAP[e.key];
  if (dir) state.keys[dir] = false;
});

// ===== 虚拟摇杆（触屏） =====
const JOYSTICK_MAX = 40;

function updateJoystickFromEvent(e) {
  const rect = joystickBase.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let dx = e.clientX - cx;
  let dy = e.clientY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > JOYSTICK_MAX) {
    dx = (dx / dist) * JOYSTICK_MAX;
    dy = (dy / dist) * JOYSTICK_MAX;
  }
  joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  state.joystick.active = dist > 6; // 小范围死区，避免手指抖动误触发
  state.joystick.dx = dx;
  state.joystick.dy = dy;
}

function resetJoystick() {
  state.joystick.pointerId = null;
  state.joystick.active = false;
  state.joystick.dx = 0;
  state.joystick.dy = 0;
  joystickKnob.style.transform = "translate(0px, 0px)";
}

joystickBase.addEventListener("pointerdown", (e) => {
  if (state.joystick.pointerId !== null) return;
  state.joystick.pointerId = e.pointerId;
  joystickBase.setPointerCapture(e.pointerId);
  updateJoystickFromEvent(e);
  e.preventDefault();
});
joystickBase.addEventListener("pointermove", (e) => {
  if (state.joystick.pointerId !== e.pointerId) return;
  updateJoystickFromEvent(e);
  e.preventDefault();
});
joystickBase.addEventListener("pointerup", (e) => {
  if (state.joystick.pointerId !== e.pointerId) return;
  resetJoystick();
});
joystickBase.addEventListener("pointercancel", (e) => {
  if (state.joystick.pointerId !== e.pointerId) return;
  resetJoystick();
});

// ===== 游戏循环 =====
function startGameLoop() {
  state.loopRunning = true;
  state.lastFrameTime = performance.now();
  state.lastBroadcast = 0;
  requestAnimationFrame(loop);
}

function stopGameLoop() {
  state.loopRunning = false;
}

function loop(now) {
  if (!state.loopRunning) return;
  const dt = Math.min((now - state.lastFrameTime) / 1000, 0.05);
  state.lastFrameTime = now;

  updateLocal(dt);
  updateRemoteRender(dt);
  recordTrail();
  updateTimer();
  checkCollision();
  draw();

  state.lastBroadcast += dt * 1000;
  if (state.lastBroadcast >= BROADCAST_MS) {
    state.lastBroadcast = 0;
    broadcastPosition();
  }

  requestAnimationFrame(loop);
}

function updateLocal(dt) {
  let dx = 0, dy = 0;
  if (state.keys.up) dy -= 1;
  if (state.keys.down) dy += 1;
  if (state.keys.left) dx -= 1;
  if (state.keys.right) dx += 1;

  if (dx === 0 && dy === 0 && state.joystick.active) {
    dx = state.joystick.dx;
    dy = state.joystick.dy;
  }

  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const speed = state.myRole === "snake" ? SNAKE_SPEED : RABBIT_SPEED;
    state.local.x += dx * speed * dt;
    state.local.y += dy * speed * dt;
    state.local.angle = Math.atan2(dy, dx);
  }

  state.local.x = clamp(state.local.x, ENTITY_RADIUS, CANVAS_W - ENTITY_RADIUS);
  state.local.y = clamp(state.local.y, ENTITY_RADIUS, CANVAS_H - ENTITY_RADIUS);
}

function updateRemoteRender(dt) {
  const t = Math.min(1, 10 * dt);
  state.remoteRender.x += (state.remote.x - state.remoteRender.x) * t;
  state.remoteRender.y += (state.remote.y - state.remoteRender.y) * t;
  state.remoteRender.angle = state.remote.angle;
}

function getSnakePos() {
  return state.myRole === "snake" ? state.local : state.remoteRender;
}
function getRabbitPos() {
  return state.myRole === "rabbit" ? state.local : state.remoteRender;
}

function recordTrail() {
  const pos = getSnakePos();
  const last = state.trail[state.trail.length - 1];
  if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= TRAIL_SEGMENT_SPACING) {
    state.trail.push({ x: pos.x, y: pos.y });
    if (state.trail.length > TRAIL_SEGMENT_COUNT) state.trail.shift();
  }
}

function updateTimer() {
  let remaining = state.roundDuration;
  if (state.startTime) remaining = state.startTime + state.roundDuration - Date.now();
  remaining = Math.max(0, remaining);
  hudTimerEl.textContent = Math.ceil(remaining / 1000);

  if (remaining <= 0 && !state.roundEnded && state.startTime) {
    state.roundEnded = true;
    state.roomRef.child("state").update({ status: "ended", winner: "rabbit" });
  }
}

function checkCollision() {
  if (state.roundEnded) return;
  const dist = Math.hypot(
    getSnakePos().x - getRabbitPos().x,
    getSnakePos().y - getRabbitPos().y
  );
  if (dist < CATCH_RADIUS) {
    state.roundEnded = true;
    state.roomRef.child("state").update({ status: "ended", winner: "snake" });
  }
}

function broadcastPosition() {
  if (!state.roomRef) return;
  state.roomRef.child(`positions/${state.myRole}`).set({
    x: state.local.x,
    y: state.local.y,
    angle: state.local.angle,
    t: Date.now(),
  });
}

function draw() {
  ctx.drawImage(gardenBg, 0, 0, CANVAS_W, CANVAS_H);
  drawSnakeTrail();
  drawRabbit(getRabbitPos());
  const snakePos = getSnakePos();
  drawSnakeHead(snakePos, snakePos.angle || 0);
}

// ===== 花园背景（离屏画布，只画一次） =====
function buildGardenBackground() {
  const bg = document.createElement("canvas");
  bg.width = CANVAS_W;
  bg.height = CANVAS_H;
  const b = bg.getContext("2d");

  // 草地底色
  const grad = b.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, "#8bc34a");
  grad.addColorStop(1, "#68a23c");
  b.fillStyle = grad;
  b.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 草叶纹理
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * CANVAS_W;
    const y = Math.random() * CANVAS_H;
    const dark = Math.random() > 0.5;
    b.strokeStyle = dark ? "rgba(0,40,0,0.10)" : "rgba(255,255,255,0.14)";
    b.lineWidth = 2;
    b.beginPath();
    b.moveTo(x, y);
    b.lineTo(x + (Math.random() * 6 - 3), y + (dark ? 8 : -8) + (Math.random() * 4 - 2));
    b.stroke();
  }

  // 弯曲小路
  b.strokeStyle = "#e3c79c";
  b.lineWidth = 44;
  b.lineCap = "round";
  b.beginPath();
  b.moveTo(-20, 470);
  b.quadraticCurveTo(220, 380, 400, 460);
  b.quadraticCurveTo(580, 540, 830, 330);
  b.stroke();

  // 池塘
  b.fillStyle = "#6fb8d8";
  b.beginPath();
  b.ellipse(95, 95, 68, 44, 0.3, 0, Math.PI * 2);
  b.fill();
  b.strokeStyle = "rgba(255,255,255,0.4)";
  b.lineWidth = 3;
  b.beginPath();
  b.ellipse(95, 95, 48, 28, 0.3, 0, Math.PI * 2);
  b.stroke();

  // 花朵
  const flowerColors = ["#ff6f91", "#ffd166", "#c77dff", "#ffffff", "#ff9770"];
  function drawFlower(x, y, scale, color) {
    b.save();
    b.translate(x, y);
    b.scale(scale, scale);
    for (let p = 0; p < 5; p++) {
      b.save();
      b.rotate(((Math.PI * 2) / 5) * p);
      b.fillStyle = color;
      b.beginPath();
      b.ellipse(0, -6, 4, 6, 0, 0, Math.PI * 2);
      b.fill();
      b.restore();
    }
    b.fillStyle = "#ffe066";
    b.beginPath();
    b.arc(0, 0, 3.5, 0, Math.PI * 2);
    b.fill();
    b.restore();
  }
  for (let i = 0; i < 24; i++) {
    const x = 40 + Math.random() * (CANVAS_W - 80);
    const y = 40 + Math.random() * (CANVAS_H - 80);
    drawFlower(x, y, 0.8 + Math.random() * 0.6, flowerColors[i % flowerColors.length]);
  }

  // 蘑菇
  function drawMushroom(x, y, scale) {
    b.save();
    b.translate(x, y);
    b.scale(scale, scale);
    b.fillStyle = "#f4e6d0";
    b.fillRect(-3, 0, 6, 10);
    b.fillStyle = "#e6483f";
    b.beginPath();
    b.ellipse(0, -2, 10, 8, 0, Math.PI, 0);
    b.fill();
    b.fillStyle = "#fff";
    [[-4, -4], [3, -6], [6, -2]].forEach(([dx, dy]) => {
      b.beginPath();
      b.arc(dx, dy, 1.6, 0, Math.PI * 2);
      b.fill();
    });
    b.restore();
  }
  for (let i = 0; i < 9; i++) {
    drawMushroom(60 + Math.random() * (CANVAS_W - 120), 60 + Math.random() * (CANVAS_H - 120), 1 + Math.random() * 0.8);
  }

  // 小风车（游乐园元素）
  function drawPinwheel(x, y) {
    b.save();
    b.translate(x, y);
    b.strokeStyle = "#8d6e4a";
    b.lineWidth = 3;
    b.beginPath();
    b.moveTo(0, 10);
    b.lineTo(0, 40);
    b.stroke();
    const colors = ["#ff6f91", "#ffd166", "#5fd0ff", "#8dff9e"];
    for (let i = 0; i < 4; i++) {
      b.save();
      b.rotate((Math.PI / 2) * i + Math.PI / 8);
      b.fillStyle = colors[i];
      b.beginPath();
      b.moveTo(0, 0);
      b.lineTo(14, -6);
      b.lineTo(14, 6);
      b.closePath();
      b.fill();
      b.restore();
    }
    b.fillStyle = "#fff8";
    b.beginPath();
    b.arc(0, 0, 3, 0, Math.PI * 2);
    b.fill();
    b.restore();
  }
  drawPinwheel(60, 545);
  drawPinwheel(730, 300);

  // 木栅栏边框
  b.fillStyle = "#d9a066";
  const postW = 10, postGap = 34;
  for (let x = 0; x < CANVAS_W; x += postGap) {
    b.fillRect(x, 0, postW, 18);
    b.fillRect(x, CANVAS_H - 18, postW, 18);
  }
  for (let y = 0; y < CANVAS_H; y += postGap) {
    b.fillRect(0, y, 18, postW);
    b.fillRect(CANVAS_W - 18, y, 18, postW);
  }

  return bg;
}

// ===== 蛇：一节一节圆滚滚的身体 + 萌脸蛇头 =====
function drawSnakeTrail() {
  const n = state.trail.length;
  for (let i = 0; i < n; i++) {
    const p = state.trail[i];
    const t = i / Math.max(1, n - 1); // 越靠近头部越大
    const r = 9 + t * 10;
    ctx.beginPath();
    ctx.fillStyle = i % 2 === 0 ? "#5fb85f" : "#4da64d";
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.arc(p.x - r * 0.3, p.y - r * 0.3, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSnakeHead(pos, angle) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(angle);

  const R = 22;
  const grad = ctx.createRadialGradient(-R * 0.3, -R * 0.3, 4, 0, 0, R);
  grad.addColorStop(0, "#8fe08f");
  grad.addColorStop(1, "#4caf50");
  ctx.beginPath();
  ctx.fillStyle = grad;
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();

  // 小舌头
  ctx.strokeStyle = "#ff6b81";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(R - 2, 0);
  ctx.lineTo(R + 12, 0);
  ctx.moveTo(R + 12, 0);
  ctx.lineTo(R + 18, -4);
  ctx.moveTo(R + 12, 0);
  ctx.lineTo(R + 18, 4);
  ctx.stroke();

  // 大眼睛
  [[5, -9], [5, 9]].forEach(([ex, ey]) => {
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(ex, ey, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#243b24";
    ctx.arc(ex + 2, ey, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(ex + 3, ey - 1.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
  });

  // 腮红
  ctx.fillStyle = "rgba(255,140,140,0.5)";
  ctx.beginPath();
  ctx.ellipse(-8, -15, 4, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-8, 15, 4, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ===== 兔子：圆滚滚身体 + 长耳朵，始终朝上更好认 =====
function drawRabbit(pos) {
  ctx.save();
  ctx.translate(pos.x, pos.y);

  const R = 20;

  function ear(dx) {
    ctx.save();
    ctx.translate(dx * 8, -R * 0.6);
    ctx.rotate(dx * 0.18);
    const earGrad = ctx.createLinearGradient(0, -30, 0, 0);
    earGrad.addColorStop(0, "#ffffff");
    earGrad.addColorStop(1, "#f4ede3");
    ctx.fillStyle = earGrad;
    ctx.beginPath();
    ctx.ellipse(0, -18, 7, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffb6c1";
    ctx.beginPath();
    ctx.ellipse(0, -16, 3.5, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ear(-1);
  ear(1);

  // 尾巴
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(0, R * 0.85, 6, 0, Math.PI * 2);
  ctx.fill();

  // 身体
  const bodyGrad = ctx.createRadialGradient(-R * 0.3, -R * 0.3, 4, 0, 0, R);
  bodyGrad.addColorStop(0, "#ffffff");
  bodyGrad.addColorStop(1, "#f0e6da");
  ctx.beginPath();
  ctx.fillStyle = bodyGrad;
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();

  // 腮红
  ctx.fillStyle = "rgba(255,150,150,0.55)";
  ctx.beginPath();
  ctx.ellipse(-11, 5, 4.5, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(11, 5, 4.5, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // 眼睛
  [[-6, -2], [6, -2]].forEach(([ex, ey]) => {
    ctx.beginPath();
    ctx.fillStyle = "#2b2b2b";
    ctx.arc(ex, ey, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(ex + 1.2, ey - 1.2, 1.2, 0, Math.PI * 2);
    ctx.fill();
  });

  // 鼻子
  ctx.beginPath();
  ctx.fillStyle = "#ff9aa8";
  ctx.moveTo(0, 3);
  ctx.lineTo(-2.5, 6);
  ctx.lineTo(2.5, 6);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ===== 事件绑定 =====
document.getElementById("btn-create").addEventListener("click", () => {
  const role = document.querySelector('input[name="create-role"]:checked').value;
  createRoom(role);
});

document.getElementById("btn-join").addEventListener("click", () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) {
    showError("请输入房间码");
    return;
  }
  joinRoom(code, code);
});

document.getElementById("btn-lobby-back").addEventListener("click", leaveRoom);
document.getElementById("btn-end-home").addEventListener("click", leaveRoom);

document.getElementById("btn-restart").addEventListener("click", () => {
  if (!state.roomRef) return;
  state.roomRef.update({
    "positions/snake": { ...spawnFor("snake"), t: Date.now() },
    "positions/rabbit": { ...spawnFor("rabbit"), t: Date.now() },
    "state/status": "playing",
    "state/startTime": firebase.database.ServerValue.TIMESTAMP,
    "state/winner": null,
  });
});
