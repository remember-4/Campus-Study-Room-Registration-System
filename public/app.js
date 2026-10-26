const $ = selector => document.querySelector(selector);
const state = { user:null, csrf:'', register:false, rooms:[], timezone:'' };
// Escape all dynamic content before it is placed into HTML templates.
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url, options={}) {
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf,...options.headers}});
  const data=await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5500);}
function campusToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:state.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function account(){ $('#account').textContent=state.user?`${state.user.name} · Sign out`:'Sign in ↗';$('#adminNav').hidden=state.user?.role!=='admin'; }
function authOpen(){ $('#authError').textContent='';$('#authDialog').showModal(); }
async function view(name){
  if ((name==='bookings'||name==='admin')&&!state.user) {authOpen();return;}
  if(name==='admin'&&state.user.role!=='admin')return;
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==name);
  document.querySelectorAll('.nav').forEach(el=>el.classList.toggle('active',el.dataset.view===name));
  try{if(name==='bookings')await bookings();if(name==='admin')await management();}catch(e){toast(e.message);}
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
$('#account').onclick=async()=>{
  if(!state.user)return authOpen();
  try{await api('/api/logout',{method:'POST'});state.user=null;account();await view('explore');toast('You have signed out.');}catch(e){toast(e.message);}
};
$('#authSwitch').onclick=()=>{
  state.register=!state.register;
  $('#nameField').hidden=!state.register;$('#nameField input').required=state.register;
  $('#passwordHelp').hidden=!state.register;
  $('#authTitle').textContent=state.register?'Make yourself at home.':'Welcome back.';
  $('#authSubmit').textContent=state.register?'Create account':'Sign in';
  $('#authForm [name=password]').autocomplete=state.register?'new-password':'current-password';
  $('#authSwitch').textContent=state.register?'Already a member? Sign in ↗':'New here? Create an account ↗';
  $('#authError').textContent='';
};
$('#authForm').onsubmit=async event=>{
  event.preventDefault();$('#authError').textContent='';$('#authSubmit').disabled=true;
  try{const data=await api(state.register?'/api/register':'/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});state.user=data.user;account();$('#authDialog').close();event.target.reset();toast(`Welcome, ${state.user.name}.`);}catch(e){$('#authError').textContent=e.message;}finally{$('#authSubmit').disabled=false;}
};
async function rooms(){
  const params=new URLSearchParams(new FormData($('#search')));
  if(!params.get('date')){params.delete('date');params.delete('start');params.delete('end');}
  for(const [key,value]of [...params])if(!value)params.delete(key);
  state.rooms=await api('/api/rooms?'+params);
  $('#roomCount').textContent=`${state.rooms.length} spaces found`;
  $('#rooms').innerHTML=state.rooms.length?state.rooms.map((r,i)=>`<article class="card"><div class="room-art tone-${i%3}" aria-hidden="true"><span class="room-badge">${esc(r.capacity)} PEOPLE</span></div><div class="card-body"><p class="building-label">${esc(r.building)}</p><h3>${esc(r.name)}</h3><p class="amenities">${esc(r.amenities)}</p><div class="card-bottom"><span>${esc(r.opens.slice(0,5))} – ${esc(r.closes.slice(0,5))}</span><button data-reserve="${r.id}">Reserve space ↗</button></div></div></article>`).join(''):'<div class="empty">No rooms match your search. Try a different time or group size.</div>';
  document.querySelectorAll('[data-reserve]').forEach(b=>b.onclick=()=>reserve(Number(b.dataset.reserve)));
}
$('#search').onsubmit=async e=>{e.preventDefault();try{await rooms();}catch(err){toast(err.message);}};
$('#clear').onclick=async()=>{$('#search').reset();try{await rooms();}catch(e){toast(e.message);}};
function reserve(id){
  if(!state.user)return authOpen();
  const room=state.rooms.find(r=>r.id===id);if(!room)return;
  const form=$('#reserveForm');form.reset();form.elements.room_id.value=id;
  form.elements.date.value=$('#searchDate').value||campusToday();
  form.elements.date.min=campusToday();
  form.elements.start.value=$('#search [name=start]').value;
  form.elements.end.value=$('#search [name=end]').value;
  $('#reserveTitle').textContent=room.name;
  $('#reserveInfo').textContent=`${room.building} · ${room.capacity} people · ${room.opens.slice(0,5)}–${room.closes.slice(0,5)} · ${state.timezone}`;
  $('#reserveError').textContent='';$('#reserveDialog').showModal();
}
$('#reserveForm').onsubmit=async e=>{
  e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;$('#reserveError').textContent='';
  try{await api('/api/reservations',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});$('#reserveDialog').close();toast('Your room is reserved. See you there!');await view('bookings');}catch(err){$('#reserveError').textContent=err.message;}finally{button.disabled=false;}
};
function dateText(value){return value.replace('T',' · ');}
async function bookings(){
  const rows=await api('/api/reservations');
  $('#bookingList').innerHTML=rows.length?rows.map(r=>`<article class="booking ${r.status==='cancelled'?'cancelled':''}"><div><p class="tag">${esc(r.status)}</p><h3>${esc(r.building)} / ${esc(r.room)}</h3><p>${esc(dateText(r.starts_at))} – ${esc(r.ends_at.slice(11))}</p><p class="muted small">${esc(r.purpose)} · ${esc(state.timezone)}</p></div>${r.status==='confirmed'?`<button class="outline" data-cancel="${r.id}">Cancel booking</button>`:''}</article>`).join(''):'<div class="empty">No bookings yet. Find a room and make it yours.</div>';
  document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Cancel this reservation?'))return;
    b.disabled=true;
    try{await api(`/api/reservations/${b.dataset.cancel}/cancel`,{method:'POST'});await bookings();toast('Reservation cancelled.');}catch(e){toast(e.message);b.disabled=false;}
  });
}
async function management(){
  const [report,list]=await Promise.all([api('/api/admin/report'),api('/api/admin/rooms')]);
  $('#report').innerHTML=`<table><thead><tr><th>Space</th><th>Building</th><th>Bookings</th><th>Scheduled hours</th></tr></thead><tbody>${report.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.building)}</td><td>${esc(r.bookings)}</td><td>${esc(r.hours)}</td></tr>`).join('')}</tbody></table>`;
  $('#adminRooms').innerHTML=list.map(r=>`<form class="booking" data-room="${r.id}"><div><h3>${esc(r.building)} / ${esc(r.name)}</h3><p class="muted">${esc(r.capacity)} people · ${r.active?'Active':'Hidden'}</p></div><div class="room-edit"><label>Opens<input type="time" name="opens" value="${esc(r.opens.slice(0,5))}" required></label><label>Closes<input type="time" name="closes" value="${esc(r.closes.slice(0,5))}" required></label><label>Availability<select name="active"><option value="true" ${r.active?'selected':''}>Active</option><option value="false" ${!r.active?'selected':''}>Hidden</option></select></label><button class="outline">Save</button></div></form>`).join('');
  document.querySelectorAll('[data-room]').forEach(f=>f.onsubmit=async e=>{
    e.preventDefault();const data=Object.fromEntries(new FormData(f));data.active=data.active==='true';const b=f.querySelector('button');b.disabled=true;
    try{await api(`/api/admin/rooms/${f.dataset.room}`,{method:'PATCH',body:JSON.stringify(data)});toast('Room updated.');await rooms();await management();}catch(err){toast(err.message);}finally{b.disabled=false;}
  });
}
$('#addRoom').onsubmit=async e=>{
  e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;
  try{await api('/api/admin/rooms',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();toast('Room added.');await management();await rooms();}catch(err){toast(err.message);}finally{b.disabled=false;}
};
async function boot(){
  try{
    const csrf=await api('/api/csrf');state.csrf=csrf.token;
    const [config,me,buildings]=await Promise.all([api('/api/config'),api('/api/me'),api('/api/buildings')]);
    state.timezone=config.timezone;state.user=me.user;account();
    $('#timezone').textContent=`All times are campus local time (${state.timezone}). Select a date to filter by availability.`;
    $('#searchDate').min=campusToday();
    for(const b of buildings){for(const selector of ['#building','#newBuilding']){const option=document.createElement('option');option.value=b.id;option.textContent=b.name;$(selector).append(option);}}
    await rooms();
  }catch(e){$('#rooms').innerHTML='<div class="empty">Unable to load rooms. Please refresh and try again.</div>';toast(e.message);}
}
boot();
