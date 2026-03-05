const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// 设置canvas默认尺寸
let canvasWidth = 800;
let canvasHeight = 600;
canvas.width = canvasWidth;
canvas.height = canvasHeight;

const cameraVideo = document.getElementById("camera");
const bgmAudio = document.getElementById("bgm");
const explosionAudio = document.getElementById("explosion");
let cameraEnabled = false;

const player = {
  x: canvasWidth / 2 - 20,
  y: canvasHeight - 60,
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
let gameStarted = false; // 新状态变量：游戏是否已开始
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
  if (!cameraVideo) {
    console.warn("未找到 camera 元素。");
    return;
  }
  
  // 检查浏览器是否支持摄像头API
  if (!navigator.mediaDevices) {
    // 尝试使用旧的API（兼容某些浏览器）
    navigator.mediaDevices = navigator.mediaDevices || {
      getUserMedia: function(constraints) {
        const getUserMedia = navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
        if (!getUserMedia) {
          console.warn("当前浏览器不支持摄像头API。");
          return Promise.reject(new Error('当前浏览器不支持摄像头API'));
        }
        return new Promise(function(resolve, reject) {
          getUserMedia.call(navigator, constraints, resolve, reject);
        });
      }
    };
  }

  try {
    // 使用更具体的视频参数，提高兼容性
    const constraints = {
      video: {
        facingMode: 'user', // 使用前置摄像头
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      }
    };
    
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraVideo.srcObject = stream;
    cameraEnabled = true;
    
    // 显式设置视频播放，解决某些浏览器需要用户交互才能播放的问题
    cameraVideo.autoplay = true;
    cameraVideo.playsInline = true;
    cameraVideo.muted = true;
    
    // 尝试直接播放视频
    try {
      await cameraVideo.play();
    } catch (playErr) {
      console.warn("自动播放视频失败，可能需要用户交互：", playErr);
    }
    
    // 当摄像头视频元数据加载完成后，根据实际尺寸调整canvas
    cameraVideo.addEventListener('loadedmetadata', () => {
      console.log("摄像头视频元数据已加载：", cameraVideo.videoWidth, "x", cameraVideo.videoHeight);
      handleResize(); // 重新调整canvas尺寸以匹配摄像头宽高比
    });
    
    // 视频可以播放时的事件
    cameraVideo.addEventListener('canplay', () => {
      console.log("摄像头视频可以播放");
    });
    
    // 视频播放错误事件
    cameraVideo.addEventListener('error', (err) => {
      console.error("摄像头视频播放错误：", err);
    });
    
  } catch (err) {
    console.error("获取摄像头权限失败：", err);
    // 更详细的错误信息
    if (err.name === 'NotAllowedError') {
      console.error("用户拒绝了摄像头权限请求。");
    } else if (err.name === 'NotFoundError') {
      console.error("未找到摄像头设备。");
    } else if (err.name === 'NotReadableError') {
      console.error("摄像头设备被占用或无法访问。");
    } else if (err.name === 'OverconstrainedError') {
      console.error("无法满足摄像头参数要求。");
    } else {
      console.error("未知的摄像头错误：", err.message);
    }
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
  player.x = canvasWidth / 2 - player.w / 2;
  player.y = canvasHeight - 60;
  obstacles = [];
  bullets = [];
  bulletCooldown = 0;
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
  const x = Math.random() * (canvasWidth - width);
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
    const targetX = handPos.x * canvasWidth - player.w / 2;
    const targetY = handPos.y * canvasHeight - player.h / 2;
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
  if (player.x + player.w > canvasWidth) player.x = canvasWidth - player.w;
  if (player.y < 0) player.y = 0;
  if (player.y + player.h > canvasHeight) player.y = canvasHeight - player.h;

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
    ctx.translate(canvasWidth, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(cameraVideo, 0, 0, canvasWidth, canvasHeight);
    ctx.restore();
    ctx.fillStyle = "rgba(15, 23, 42, 0.4)";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
    gradient.addColorStop(0, "#020617");
    gradient.addColorStop(1, "#0f172a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  ctx.fillStyle = "rgba(148, 163, 184, 0.12)";
  for (let y = 0; y < canvasHeight; y += 30) {
    ctx.fillRect(0, y, canvasWidth, 1);
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
  ctx.fillRect(30, canvasHeight / 2 - 70, canvasWidth - 60, 140);

  ctx.fillStyle = "#e5e7eb";
  ctx.textAlign = "center";
  ctx.font = "28px system-ui";
  ctx.fillText("游戏结束", canvasWidth / 2, canvasHeight / 2 - 20);

  ctx.font = "18px system-ui";
  ctx.fillText(`得分：${score}`, canvasWidth / 2, canvasHeight / 2 + 10);

  ctx.font = "14px system-ui";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("按空格键或点击按钮重新开始", canvasWidth / 2, canvasHeight / 2 + 40);
  
  // 绘制重新开始按钮
  const btnWidth = 160;
  const btnHeight = 40;
  const btnX = canvasWidth / 2 - btnWidth / 2;
  const btnY = canvasHeight / 2 + 60;
  
  // 按钮背景
  const btnGradient = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnHeight);
  btnGradient.addColorStop(0, "#3b82f6");
  btnGradient.addColorStop(1, "#1e40af");
  ctx.fillStyle = btnGradient;
  ctx.fillRect(btnX, btnY, btnWidth, btnHeight, 8);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1;
  ctx.strokeRect(btnX, btnY, btnWidth, btnHeight, 8);
  
  // 按钮文字
  ctx.fillStyle = "white";
  ctx.font = "16px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("重新开始", canvasWidth / 2, btnY + btnHeight / 2 + 6);
}

// 绘制开始游戏画面
function drawStartScreen() {
  // 绘制背景
  drawBackground();
  
  // 绘制半透明遮罩
  ctx.fillStyle = "rgba(15, 23, 42, 0.7)";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  // 游戏标题
  ctx.fillStyle = "#e5e7eb";
  ctx.textAlign = "center";
  ctx.font = "42px system-ui";
  ctx.fillText("飞机大战", canvasWidth / 2, canvasHeight / 2 - 80);
  
  // 副标题
  ctx.font = "18px system-ui";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("用右手食指控制飞机", canvasWidth / 2, canvasHeight / 2 - 40);
  ctx.fillText("自动发射子弹，击中敌机得分", canvasWidth / 2, canvasHeight / 2 - 15);
  
  // 绘制开始游戏按钮
  const btnWidth = 200;
  const btnHeight = 50;
  const btnX = canvasWidth / 2 - btnWidth / 2;
  const btnY = canvasHeight / 2 + 20;
  
  // 按钮背景
  const btnGradient = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnHeight);
  btnGradient.addColorStop(0, "#3b82f6");
  btnGradient.addColorStop(1, "#1e40af");
  ctx.fillStyle = btnGradient;
  ctx.fillRect(btnX, btnY, btnWidth, btnHeight);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 2;
  ctx.strokeRect(btnX, btnY, btnWidth, btnHeight);
  
  // 按钮文字
  ctx.fillStyle = "white";
  ctx.font = "20px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("开始游戏", canvasWidth / 2, btnY + btnHeight / 2 + 8);
  
  // 提示文字
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("点击按钮或按空格键开始", canvasWidth / 2, canvasHeight / 2 + 90);
}

function loop(timestamp) {
  if (!gameStarted) {
    drawStartScreen();
    requestAnimationFrame(loop);
    return;
  }

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
  
  // 处理开始游戏
  if (e.code === "Space" && !gameStarted) {
    e.preventDefault();
    gameStarted = true;
    resetGame(); // 确保游戏状态正确初始化
    return;
  }
  
  // 处理游戏结束时的重新开始
  if (e.code === "Space" && gameOver) {
    e.preventDefault();
    resetGame();
    return;
  }
  
  // 只有在游戏开始后才处理移动按键
  if (gameStarted && !gameOver) {
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
  }
});

window.addEventListener("keyup", (e) => {
  // 只有在游戏开始后才处理移动按键的释放
  if (gameStarted && !gameOver) {
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
  }
});

// 鼠标点击页面/画布也可以触发一次 BGM（兼容有的浏览器只认点击）
window.addEventListener("click", () => {
  startBgm();
});

// 处理canvas点击事件
canvas.addEventListener("click", (e) => {
  startBgm();
  
  // 检查点击位置
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  
  const clickX = (e.clientX - rect.left) * scaleX;
  const clickY = (e.clientY - rect.top) * scaleY;
  
  // 如果在开始屏幕，检查是否点击了开始游戏按钮
  if (!gameStarted) {
    const btnWidth = 200;
    const btnHeight = 50;
    const btnX = canvasWidth / 2 - btnWidth / 2;
    const btnY = canvasHeight / 2 + 20;
    
    if (clickX >= btnX && clickX <= btnX + btnWidth && clickY >= btnY && clickY <= btnY + btnHeight) {
      gameStarted = true;
      resetGame(); // 确保游戏状态正确初始化
    }
    return;
  }
  
  // 如果游戏结束，检查是否点击了重新开始按钮
  if (gameOver) {
    const btnWidth = 160;
    const btnHeight = 40;
    const btnX = canvasWidth / 2 - btnWidth / 2;
    const btnY = canvasHeight / 2 + 60;
    
    if (clickX >= btnX && clickX <= btnX + btnWidth && clickY >= btnY && clickY <= btnY + btnHeight) {
      resetGame();
    }
  }
});

// 处理窗口大小变化
function handleResize() {
  const maxWidth = 800;
  const maxHeight = 600;
  let aspectRatio = 4 / 3; // 默认比例
  
  // 如果摄像头可用，使用摄像头的实际宽高比
  if (cameraEnabled && cameraVideo.videoWidth && cameraVideo.videoHeight) {
    aspectRatio = cameraVideo.videoWidth / cameraVideo.videoHeight;
  }
  
  // 获取父容器的可用宽度
  const containerWidth = Math.min(maxWidth, window.innerWidth - 40);
  const containerHeight = Math.min(maxHeight, window.innerHeight - 120);
  
  // 计算适合的canvas尺寸，保持宽高比
  let newWidth = containerWidth;
  let newHeight = newWidth / aspectRatio;
  
  if (newHeight > containerHeight) {
    newHeight = containerHeight;
    newWidth = newHeight * aspectRatio;
  }
  
  // 更新canvas尺寸
  canvasWidth = Math.round(newWidth);
  canvasHeight = Math.round(newHeight);
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  
  // 更新player位置
  player.x = Math.min(player.x, canvasWidth - player.w);
  player.y = Math.min(player.y, canvasHeight - player.h);
}

// 初始化大小并监听窗口变化
window.addEventListener("resize", handleResize);
handleResize();

lastTime = performance.now();
requestAnimationFrame(loop);
initCamera();
processHandTracking();

// 尝试在页面加载后立即播放 BGM（可能被浏览器静音，后续按键/点击会再尝试）
window.addEventListener("load", () => {
  startBgm();
});

// 添加多种用户交互事件监听器，确保在任何用户交互时都能触发音频播放
// 针对手机端的触摸事件
window.addEventListener("touchstart", () => {
  startBgm();
  // 只需要触发一次，移除事件监听器
  window.removeEventListener("touchstart", arguments.callee);
});

// 针对键盘事件
window.addEventListener("keydown", () => {
  startBgm();
  // 只需要触发一次，移除事件监听器
  window.removeEventListener("keydown", arguments.callee);
});

// 针对鼠标移动事件
window.addEventListener("mousemove", () => {
  startBgm();
  // 只需要触发一次，移除事件监听器
  window.removeEventListener("mousemove", arguments.callee);
});

// 针对页面可见性变化事件（当页面从后台切换到前台时）
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    startBgm();
    // 页面从不可见变为可见时，检查并重新初始化摄像头
    if (!cameraVideo.srcObject || cameraVideo.paused || cameraVideo.ended) {
      console.log("页面恢复可见，重新初始化摄像头");
      // 先停止当前的摄像头流
      if (cameraVideo.srcObject) {
        cameraVideo.srcObject.getTracks().forEach(track => track.stop());
        cameraVideo.srcObject = null;
      }
      // 重新初始化摄像头
      initCamera();
    }
  }
});

// 初始尝试播放BGM
startBgm();
