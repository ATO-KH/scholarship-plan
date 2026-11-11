(() => {
  const seen = new Set();
  let stopCurrent = () => {};
  function play(kind) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) return;
    stopCurrent();
    const canvas = document.createElement('canvas');
    canvas.className = 'celebration-canvas';canvas.setAttribute('aria-hidden','true');document.body.append(canvas);
    const ctx=canvas.getContext('2d');if(!ctx){canvas.remove();return;}
    const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;ctx.scale(dpr,dpr);
    const colors=['#ffba49','#ff9b26','#3a7ec3','#1f4e79'];
    const particles=[];
    for(let i=0;i<(kind==='fireworks'?180:130);i++) {
      const group=i%3,angle=Math.random()*Math.PI*2,speed=60+Math.random()*160;
      particles.push({x:kind==='fireworks'?w*(.22+group*.28):Math.random()*w,y:kind==='fireworks'?h*(.25+(group%2)*.15):-Math.random()*h*.3,vx:kind==='fireworks'?Math.cos(angle)*speed:(Math.random()-.5)*180,vy:kind==='fireworks'?Math.sin(angle)*speed:100+Math.random()*150,color:colors[i%4],delay:kind==='fireworks'?group*.35:0,spin:Math.random()*6});
    }
    let start,previous,frame;
    const cleanup=()=>{cancelAnimationFrame(frame);canvas.remove();document.removeEventListener('visibilitychange',hide);};
    const hide=()=>{if(document.hidden)cleanup();};document.addEventListener('visibilitychange',hide);stopCurrent=cleanup;
    function tick(now){start??=now;previous??=now;const elapsed=(now-start)/1000,dt=Math.min((now-previous)/1000,.05);previous=now;ctx.clearRect(0,0,w,h);
      for(const p of particles){if(elapsed<p.delay)continue;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=(kind==='fireworks'?75:110)*dt;ctx.globalAlpha=Math.max(0,1-(elapsed-p.delay)/(kind==='fireworks'?2.3:3));ctx.fillStyle=p.color;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.spin+elapsed*3);if(kind==='fireworks'){ctx.beginPath();ctx.arc(0,0,2.5,0,Math.PI*2);ctx.fill();}else ctx.fillRect(-3,-5,6,10);ctx.restore();}
      if(elapsed<3.2)frame=requestAnimationFrame(tick);else cleanup();
    }frame=requestAnimationFrame(tick);
  }
  function checkpoint({ memberId, role, approved, today, checkpoints = [], semesterKey = '' }) {
    if (!memberId || role !== 'member' || approved !== 0 || !/^\d{4}-\d{2}-\d{2}$/.test(today || '') ||
        matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) return false;
    const dates = [...new Set(checkpoints.map(item => item.date)
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date))))].sort();
    const passed = dates.filter(date => date < today);
    if (!passed.length) return false;
    const weeks = (after, before) => Math.max(0, Math.floor((Date.parse(after) - Date.parse(before)) / 604800000));
    let count = 3 + 2 * weeks(today, dates[0]);
    if (passed.length >= 2) {
      // Each new phase starts above the preceding phase, even if dates are moved.
      const secondBase = Math.max(12, 3 + 2 * weeks(dates[1], dates[0]) + 3);
      count = secondBase + 4 * weeks(today, dates[1]);
      if (passed.length >= 3) {
        const thirdBase = Math.max(24, secondBase + 4 * weeks(dates[2], dates[1]) + 6);
        count = thirdBase * 2 ** weeks(today, dates[2]);
      }
    }
    count = Math.min(96, count);
    const key = `ato-checkpoint-tomato:${memberId}:${semesterKey}:${passed.at(-1)}:${weeks(today, passed.at(-1))}`;
    if (seen.has(key)) return false;
    // Guard ordinary dashboard redraws, but replay after a full page refresh.
    seen.add(key);
    stopCurrent();
    const layer = document.createElement('div');
    layer.className = 'checkpoint-tomato';
    layer.setAttribute('aria-hidden', 'true');
    const sprites = document.createElement('template');
    sprites.innerHTML = `<svg class="tomato-flight" viewBox="0 0 120 120" focusable="false">
      <path d="M60 27C37 15 13 34 13 62c0 30 20 47 47 47s47-17 47-47c0-28-24-47-47-35Z" fill="#d93425"/>
      <path d="M60 31c-18-3-36 11-36 32 0 20 13 33 28 36-9-11-13-23-10-39 2-14 8-22 18-29Z" fill="#f35b39"/>
      <path d="m60 38-22-4 16-9-4-13 13 12 18-9-7 16 18 10-24-2-9 13Z" fill="#35753b"/>
      <path d="M62 28c-1-10 2-17 8-21" fill="none" stroke="#24582b" stroke-width="5" stroke-linecap="round"/>
      <ellipse cx="34" cy="49" rx="5" ry="10" transform="rotate(32 34 49)" fill="#ffb58c"/>
    </svg><svg class="tomato-splat" viewBox="0 0 240 240" focusable="false">
      <g fill="#d93425"><path d="M111 64c-6-23-24-38-32-30-7 7 12 29 6 43-10 9-44-2-45 10-2 12 28 14 29 25-3 16-37 30-30 42 9 12 35-15 49-12 9 8-1 49 12 51 13 2 16-37 28-39 13 0 31 35 42 26 10-9-17-35-12-47 8-11 42-4 44-17 2-12-32-15-36-25-5-10 26-33 14-43-12-10-34 22-45 20-8-5-6-28-17-29-10 0 0 19-7 25Z"/>
      <ellipse cx="25" cy="55" rx="7" ry="12" transform="rotate(-38 25 55)"/><ellipse cx="209" cy="62" rx="6" ry="10" transform="rotate(38 209 62)"/>
      <ellipse cx="213" cy="169" rx="11" ry="6" transform="rotate(32 213 169)"/><ellipse cx="59" cy="204" rx="6" ry="10" transform="rotate(32 59 204)"/>
      <circle cx="124" cy="214" r="6"/><circle cx="18" cy="127" r="5"/><circle cx="166" cy="20" r="5"/></g>
      <path d="M87 94c6-22 42-23 54-1 12 18-2 39-20 45-23 3-43-22-34-44Z" fill="#f15332"/>
      <g fill="#ffce8b"><ellipse cx="104" cy="96" rx="3" ry="6" transform="rotate(-28 104 96)"/><ellipse cx="131" cy="114" rx="3" ry="6" transform="rotate(35 131 114)"/><ellipse cx="104" cy="124" rx="3" ry="5"/></g>
    </svg>`;
    const throwDuration = 700;
    let lifetime = 0;
    // Scatter a bounded barrage across the viewport rather than stacking every
    // splash at the center. The stagger keeps the impact readable on phones too.
    for (let index = 0; index < count; index++) {
      const position = index * 11 % 24;
      const column = position % 6, row = Math.floor(position / 6);
      const delay = Math.round(index * 3000 / Math.max(1, count - 1)) + (index ? Math.floor(Math.random() * 70) : 0);
      const impactAt = delay + throwDuration - 20;
      const splatDuration = 11000 + index % 4 * 350;
      const impact = document.createElement('div');
      impact.className = 'tomato-impact';
      const values = {
        '--impact-x': `${8 + (column + .5) * 14 + (Math.random() - .5) * 6}%`,
        '--impact-y': `${6 + (row + .5) * 15.5 + (Math.random() - .5) * 6}%`,
        '--throw-x': `${index % 2 ? 65 : -65}vw`,
        '--throw-y': `${65 + Math.random() * 20}vh`,
        '--tomato-size': `${50 + Math.random() * 24}px`,
        '--splat-size': `${28 + Math.random() * 16}vmin`,
        '--splat-angle': `${Math.random() * 80 - 40}deg`,
        '--splat-drift': `${Math.random() * 8 - 4}vw`,
        '--splat-drop': `${28 + Math.random() * 18}vh`,
        '--throw-duration': `${throwDuration}ms`,
        '--throw-delay': `${delay}ms`,
        '--impact-delay': `${impactAt}ms`,
        '--splat-duration': `${splatDuration}ms`,
      };
      for (const [name, value] of Object.entries(values)) impact.style.setProperty(name, value);
      impact.append(sprites.content.cloneNode(true));
      layer.append(impact);
      lifetime = Math.max(lifetime, impactAt + splatDuration);
    }
    document.body.append(layer);
    let timer;
    const cleanup = () => {
      clearTimeout(timer); layer.remove();
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', cleanup);
      window.removeEventListener('pagehide', cleanup);
    };
    const hide = () => { if (document.hidden) cleanup(); };
    const escape = event => { if (event.key === 'Escape') cleanup(); };
    stopCurrent = cleanup;
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', cleanup, { once: true });
    window.addEventListener('pagehide', cleanup, { once: true });
    timer = setTimeout(cleanup, lifetime + 100);
    return true;
  }
  window.atoCelebrate={submission:()=>play('confetti'),goal:(key,approved,goal)=>{if(goal>0&&approved>=goal&&!seen.has(key)){seen.add(key);play('fireworks');}},checkpoint,stop:()=>stopCurrent()};
})();
