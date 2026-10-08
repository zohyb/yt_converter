/* TubeSnap particle background — dependency-free canvas engine.
   Slow drifting particles with connecting lines, mouse repel + glow,
   click bursts. Respects prefers-reduced-motion. */
(() => {
  const canvas = document.getElementById('bg-particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // stay static

  const COLORS = ['22,163,74', '45,212,191', '148,163,184']; // green, teal, slate
  const LINK_DIST = 120;
  const MOUSE_DIST = 150;
  const MOUSE_LINK_DIST = 170;

  let w = 0, h = 0, particles = [], running = true;
  const mouse = { x: -9999, y: -9999, down: false };

  function spawn(x, y, burst) {
    return {
      x: x !== undefined ? x : Math.random() * w,
      y: y !== undefined ? y : Math.random() * h,
      vx: (Math.random() - 0.5) * (burst ? 3.2 : 0.35),
      vy: (Math.random() - 0.5) * (burst ? 3.2 : 0.35),
      r: Math.random() * 2.2 + 0.8,
      c: COLORS[(Math.random() * COLORS.length) | 0],
      a: Math.random() * 0.45 + 0.25,
      life: burst ? 1 : Infinity, // burst particles fade out
    };
  }

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.max(50, Math.min(150, Math.floor((w * h) / 15000)));
    particles = Array.from({ length: count }, () => spawn());
  }

  function step() {
    ctx.clearRect(0, 0, w, h);

    // move + mouse repel
    for (const p of particles) {
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < MOUSE_DIST * MOUSE_DIST && d2 > 1) {
        const d = Math.sqrt(d2);
        const force = ((MOUSE_DIST - d) / MOUSE_DIST) * 0.9;
        p.vx += (dx / d) * force;
        p.vy += (dy / d) * force;
      }
      // gentle friction back toward base drift
      p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx; p.y += p.vy;

      if (p.x < -20) p.x = w + 20; if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20; if (p.y > h + 20) p.y = -20;

      if (p.life !== Infinity) {
        p.life -= 0.012;
        p.a *= 0.985;
      }
    }
    particles = particles.filter(p => p.life > 0 && p.a > 0.02);
    // top up ambient particles
    const target = Math.max(50, Math.min(150, Math.floor((w * h) / 15000)));
    while (particles.filter(p => p.life === Infinity).length < target) particles.push(spawn());

    // links between particles
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d = Math.hypot(dx, dy);
        if (d < LINK_DIST) {
          ctx.strokeStyle = `rgba(45,212,191,${(1 - d / LINK_DIST) * 0.14})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
      // link particle -> mouse (the "sexy" hover bit)
      const mdx = p.x - mouse.x, mdy = p.y - mouse.y;
      const md = Math.hypot(mdx, mdy);
      if (md < MOUSE_LINK_DIST) {
        ctx.strokeStyle = `rgba(22,163,74,${(1 - md / MOUSE_LINK_DIST) * 0.35})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
      }
      // dot with soft glow
      const glow = md < MOUSE_LINK_DIST ? 1.8 : 1;
      ctx.fillStyle = `rgba(${p.c},${Math.min(1, p.a * glow)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * glow, 0, Math.PI * 2); ctx.fill();
    }

    if (running) requestAnimationFrame(step);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  window.addEventListener('pointerleave', () => { mouse.x = -9999; mouse.y = -9999; });
  window.addEventListener('click', (e) => {
    for (let i = 0; i < 14; i++) particles.push(spawn(e.clientX, e.clientY, true));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { running = false; }
    else if (!running) { running = true; requestAnimationFrame(step); }
  });

  resize();
  requestAnimationFrame(step);
})();
