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
  window.atoCelebrate={submission:()=>play('confetti'),goal:(key,approved,goal)=>{if(goal>0&&approved>=goal&&!seen.has(key)){seen.add(key);play('fireworks');}}};
})();
