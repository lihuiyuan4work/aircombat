const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const cameraVideo = document.getElementById("camera");
const bgmAudio = document.getElementById("bgm");
const explosionAudio = document.getElementById("explosion");
let cameraEnabled = false;

const player = {
  x: canvas.width / 2 - 20,
  y: canvas.height - 60,
  w: 40,
  h: 40,
  speed: 6,
};

let keys = {
  left: false,
  right: false,
  up: false,
  down: false,
};

let obstacles = [];
let bullets = [];
let bulletCooldown = 0;
let lastSpawn = 0;
let spawnInterval = 900;
let gameOver = false;
let score = 0;
let lastTime = 0;

const scoreEl = document.getElementById("score");

let bgmStarted = false;

function startBgm() {
  if (!bgmAudio || bgmStarted) return;
  bgmAudio.volume = 0.8;
  bgmAudio.loop = true;
  bgmAudio
    .play()
    .then(() => {
      bgmStarted = true;
    })
    .catch(() => {
      // 某些浏览器需要用户再次交互才能播放
    });
}

function stopBgm() {
  if (!bgmAudio) return;
  try {
    bgmAudio.pause();
  } catch {
    // ignore
  }
  bgmStarted = false;
}

function playExplosion() {
  if (!explosionAudio) return;
  try {
    const boom = explosionAudio.cloneNode();
    boom.volume = 0.9;
    boom.currentTime = 0;
    boom.play().catch(() => {});
    setTimeout(() => {
      boom.pause();
    }, 400); // 只保留大约 0.4 秒的爆炸声
  } catch {
    // 忽略音频错误，避免影响游戏
  }
}

// 手部位置（归一化），默认靠近底部中间
let handPos = { x: 0.5, y: 0.8 };
let useHandControl = false;

async function initCamera() {
  if (!cameraVideo || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn("当前环境不支持摄像头或未找到 camera 元素。");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraVideo.srcObject = stream;
    cameraEnabled = true;
  } catch (err) {
    console.error("获取摄像头权限失败：", err);
  }
}

// 初始化 MediaPipe Hands，用于手部跟踪
let hands = null;

if (window.Hands) {
  hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  hands.onResults((results) => {
    if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) return;
    const landmarks = results.multiHandLandmarks[0];

    // 使用食指指尖（索引 8）作为“手的控制点”
    const indexTip = landmarks[8];
    if (!indexTip) return;

    // 水平反转（镜像），让“向左移手 → 角色往左”
    handPos.x = 1 - indexTip.x;
    handPos.y = indexTip.y;
    useHandControl = true;
  });
} else {
  console.warn("Hands 库未正确加载，手部控制不可用。");
}

async function processHandTracking() {
  if (!hands) {
    return;
  }
  if (cameraEnabled && cameraVideo.readyState >= 2) {
    try {
      await hands.send({ image: cameraVideo });
    } catch (e) {
      console.error("Hands 处理出错：", e);
    }
  }
  requestAnimationFrame(processHandTracking);
}

function resetGame() {
  player.x = canvas.width / 2 - player.w / 2;
  obstacles = [];
  lastSpawn = 0;
  spawnInterval = 900;
  gameOver = false;
  score = 0;
  lastTime = performance.now();
  scoreEl.textContent = "0";
  startBgm();
  requestAnimationFrame(loop);
}

function spawnObstacle() {
  const width = 40 + Math.random() * 40;
  const x = Math.random() * (canvas.width - width);
  const speed = 2 + Math.random() * 2 + score * 0.01;
  obstacles.push({
    x,
    y: -30,
    w: width,
    h: 20 + Math.random() * 10,
    speed,
    type: Math.floor(Math.random() * 3), // 敌机样式 0/1/2
  });
}

function update(dt) {
  bulletCooldown -= dt;

  if (useHandControl) {
    // 手部位置控制角色（平滑移动）
    const targetX = handPos.x * canvas.width - player.w / 2;
    const targetY = handPos.y * canvas.height - player.h / 2;
    const alpha = 0.75; // 越大越“跟手”
    player.x += (targetX - player.x) * alpha;
    player.y += (targetY - player.y) * alpha;
  } else {
    // 备用：键盘控制
    if (keys.left) {
      player.x -= player.speed;
    }
    if (keys.right) {
      player.x += player.speed;
    }
    if (keys.up) {
      player.y -= player.speed;
    }
    if (keys.down) {
      player.y += player.speed;
    }
  }

  // 边界限制
  if (player.x < 0) player.x = 0;
  if (player.x + player.w > canvas.width) player.x = canvas.width - player.w;
  if (player.y < 0) player.y = 0;
  if (player.y + player.h > canvas.height) player.y = canvas.height - player.h;

  // 自动发射子弹
  const bulletInterval = 80; // 毫秒（越小射得越快）
  if (!gameOver && bulletCooldown <= 0) {
    bullets.push({
      x: player.x + player.w / 2 - 2,
      y: player.y - 8,
      w: 4,
      h: 12,
      speed: 15,
    });
    bulletCooldown = bulletInterval;
  }

  lastSpawn += dt;
  if (lastSpawn > spawnInterval) {
    spawnObstacle();
    lastSpawn = 0;
    if (spawnInterval > 350) {
      spawnInterval -= 10;
    }
  }

  obstacles.forEach((o) => {
    o.y += o.speed;
  });

  // 更新子弹位置
  bullets.forEach((b) => {
    b.y -= b.speed;
  });

  // 子弹与方块碰撞检测
  const bulletsToRemove = new Set();
  const obstaclesToRemove = new Set();

  bullets.forEach((b, bi) => {
    obstacles.forEach((o, oi) => {
      if (
        b.x < o.x + o.w &&
        b.x + b.w > o.x &&
        b.y < o.y + o.h &&
        b.y + b.h > o.y
      ) {
        bulletsToRemove.add(bi);
        obstaclesToRemove.add(oi);
        score += 1;
        scoreEl.textContent = String(score);
        playExplosion();
      }
    });
  });

  // 清理子弹
  bullets = bullets.filter((b, i) => {
    if (bulletsToRemove.has(i)) return false;
    if (b.y + b.h < 0) return false;
    return true;
  });

  // 清理方块（被打掉或掉出屏幕）
  obstacles = obstacles.filter((o, i) => {
    if (obstaclesToRemove.has(i)) {
      return false;
    }
    if (o.y > canvas.height + 40) {
      return false;
    }
    return true;
  });

  for (const o of obstacles) {
    if (
      player.x < o.x + o.w &&
      player.x + player.w > o.x &&
      player.y < o.y + o.h &&
      player.y + player.h > o.y
    ) {
      gameOver = true;
      stopBgm();
      break;
    }
  }
}

function drawBackground() {
  if (cameraEnabled && cameraVideo.readyState >= 2) {
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.fillStyle = "rgba(15, 23, 42, 0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#020617");
    gradient.addColorStop(1, "#0f172a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.fillStyle = "rgba(148, 163, 184, 0.12)";
  for (let y = 0; y < canvas.height; y += 30) {
    ctx.fillRect(0, y, canvas.width, 1);
  }
}

function drawPlayer() {
  const cx = player.x + player.w / 2;
  const cy = player.y + player.h / 2;

  // 机身
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.moveTo(cx, player.y - 4); // 机头
  ctx.lineTo(player.x, player.y + player.h - 4);
  ctx.lineTo(player.x + player.w, player.y + player.h - 4);
  ctx.closePath();
  ctx.fill();

  // 机翼
  ctx.fillStyle = "#0ea5e9";
  ctx.fillRect(player.x - 6, cy - 4, 12, 8);
  ctx.fillRect(player.x + player.w - 6, cy - 4, 12, 8);

  // 尾翼
  ctx.fillStyle = "#0369a1";
  ctx.fillRect(cx - 4, player.y + player.h - 6, 8, 10);
}

function drawBullets() {
  ctx.fillStyle = "#fbbf24";
  bullets.forEach((b) => {
    ctx.fillRect(b.x, b.y, b.w, b.h);
  });
}

function drawObstacles() {
  obstacles.forEach((o) => {
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;

    switch (o.type) {
      case 0: {
        // 敌机 A：红色三角战机（机头朝下）
        ctx.fillStyle = "#f97373";
        ctx.beginPath();
        ctx.moveTo(cx, o.y + o.h + 6);
        ctx.lineTo(o.x - 4, o.y - 4);
        ctx.lineTo(o.x + o.w + 4, o.y - 4);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#7f1d1d";
        ctx.fillRect(cx - 4, cy - 2, 8, 6);
        break;
      }
      case 1: {
        // 敌机 B：紫色飞碟
        ctx.fillStyle = "#a855f7";
        ctx.beginPath();
        ctx.ellipse(cx, cy + 2, o.w / 2 + 6, o.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#e9d5ff";
        ctx.beginPath();
        ctx.ellipse(cx, o.y, o.w / 3, o.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: {
        // 敌机 C：青色菱形战机
        ctx.fillStyle = "#22d3ee";
        ctx.beginPath();
        ctx.moveTo(cx, o.y - 4);
        ctx.lineTo(o.x - 4, cy);
        ctx.lineTo(cx, o.y + o.h + 4);
        ctx.lineTo(o.x + o.w + 4, cy);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#0f172a";
        ctx.fillRect(cx - 3, cy - 3, 6, 6);
        break;
      }
    }
  });
}

function drawGameOver() {
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
  ctx.fillRect(30, canvas.height / 2 - 70, canvas.width - 60, 140);

  ctx.fillStyle = "#e5e7eb";
  ctx.textAlign = "center";
  ctx.font = "28px system-ui";
  ctx.fillText("游戏结束", canvas.width / 2, canvas.height / 2 - 20);

  ctx.font = "18px system-ui";
  ctx.fillText(`得分：${score}`, canvas.width / 2, canvas.height / 2 + 10);

  ctx.font = "14px system-ui";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("按空格键重新开始", canvas.width / 2, canvas.height / 2 + 40);
}

function loop(timestamp) {
  if (gameOver) {
    drawBackground();
    drawPlayer();
    drawObstacles();
    drawGameOver();
    return;
  }

  const dt = timestamp - lastTime;
  lastTime = timestamp;

  update(dt);

  drawBackground();
  drawObstacles();
  drawBullets();
  drawPlayer();

  requestAnimationFrame(loop);
}

window.addEventListener("keydown", (e) => {
  // 任意按键触发一次背景音乐
  startBgm();
  if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
    keys.left = true;
  }
  if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
    keys.right = true;
  }
   if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
    keys.up = true;
  }
  if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
    keys.down = true;
  }
  if (e.code === "Space" && gameOver) {
    e.preventDefault();
    resetGame();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
    keys.left = false;
  }
  if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
    keys.right = false;
  }
  if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
    keys.up = false;
  }
  if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
    keys.down = false;
  }
});

// 鼠标点击页面/画布也可以触发一次 BGM（兼容有的浏览器只认点击）
window.addEventListener("click", () => {
  startBgm();
});
canvas.addEventListener("click", () => {
  startBgm();
});

lastTime = performance.now();
requestAnimationFrame(loop);
initCamera();
processHandTracking();

// 尝试在页面加载后立即播放 BGM（可能被浏览器静音，后续按键/点击会再尝试）
window.addEventListener("load", () => {
  startBgm();
});
startBgm();
