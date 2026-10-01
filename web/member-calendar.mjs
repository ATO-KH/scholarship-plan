export function mountMemberCalendar(container, { user, rules, points, submissions, esc, openSubmission }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let month = today.slice(0,7);
  const checkpoints = rules.checkpoints || [];
  const own = submissions.filter(item => item.owner === user.id);
  function render() {
    const [year, m] = month.split('-').map(Number), first = new Date(Date.UTC(year,m-1,1));
    const days = new Date(Date.UTC(year,m,0)).getUTCDate(), offset = first.getUTCDay();
    const title = first.toLocaleDateString('en-US', { month:'long', year:'numeric', timeZone:'UTC' });
    let cells = '';
    for (let i=0;i<Math.ceil((offset+days)/7)*7;i++) {
      const day=i-offset+1;
      if(day<1||day>days){cells+='<div class="calendar-day calendar-blank" aria-hidden="true"></div>';continue;}
      const date=`${month}-${String(day).padStart(2,'0')}`;
      const events = own.filter(item=>item.date===date);
      const due = checkpoints.filter(item=>item.date===date);
      cells+=`<section class="calendar-day${date===today?' is-today':''}" aria-label="${esc(date)}"><time datetime="${date}"${date===today?' aria-current="date"':''}>${day}${date===today?' · Today':''}</time>${due.map(checkpoint=>{
        const target=checkpoint.targets[user.tier-1];const remaining=Math.max(0,target-points.approved);
        return `<details class="calendar-checkpoint"><summary title="${remaining} points to go! ${points.approved} approved / ${target} required">Checkpoint · ${target} pts</summary><div class="calendar-checkpoint-tip">${remaining} points to go!<small>${points.approved} approved / ${target} required</small></div></details>`;
      }).join('')}${events.map(item=>`<button class="calendar-submission ${esc(item.status)}" data-calendar-submission="${esc(item.id)}" title="${esc(item.title)} · ${esc(item.status)}">${esc(item.title)}<small>${esc(item.status)}${item.status==='approved'?` · +${item.awarded} pts`:''}</small></button>`).join('')}</section>`;
    }
    container.innerHTML=`<div class="calendar-toolbar"><h2>${title}</h2><div><button class="button ghost small" data-month="-1" aria-label="Previous month">←</button><button class="button ghost small" data-today>Today</button><button class="button ghost small" data-month="1" aria-label="Next month">→</button><button class="button ghost small" data-fullscreen>${document.fullscreenElement===container?'Exit full screen':'Full screen'}</button></div></div><nav class="calendar-checkpoint-links" aria-label="All semester checkpoints">${checkpoints.map((item,index)=>`<button class="button ghost small" data-checkpoint-month="${item.date.slice(0,7)}">${index===checkpoints.length-1?'Semester goal':'Checkpoint '+(index+1)} · ${esc(item.date)}<span>${Math.max(0,item.targets[user.tier-1]-points.approved)} points to go</span></button>`).join('')}</nav><div class="calendar-scroll"><div class="member-calendar-grid">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<div class="calendar-weekday">${day}</div>`).join('')}${cells}</div></div>`;
    container.querySelectorAll('[data-month]').forEach(button=>button.onclick=()=>{const next=new Date(Date.UTC(year,m-1+Number(button.dataset.month),1));month=next.toISOString().slice(0,7);render();});
    container.querySelector('[data-today]').onclick=()=>{month=today.slice(0,7);render();};
    container.querySelectorAll('[data-checkpoint-month]').forEach(button=>button.onclick=()=>{month=button.dataset.checkpointMonth;render();});
    container.querySelectorAll('[data-calendar-submission]').forEach(button=>button.onclick=()=>openSubmission(button.dataset.calendarSubmission));
    const fullscreen=container.querySelector('[data-fullscreen]');
    fullscreen.hidden=!container.requestFullscreen;
    fullscreen.onclick=async()=>{try{if(document.fullscreenElement===container)await document.exitFullscreen();else await container.requestFullscreen();fullscreen.textContent=document.fullscreenElement===container?'Exit full screen':'Full screen';}catch{fullscreen.textContent='Full screen unavailable';}};
  }
  render();
}
